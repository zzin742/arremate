"""Testes do worker de mídia.

Os que mexem em FFmpeg geram um vídeo de verdade com o próprio FFmpeg
(fonte `testsrc`), em vez de usar um arquivo fixo no repositório: assim o
teste prova que a conversão funciona, e não que um .mp4 commitado existe.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from conversao import (  # noqa: E402
    ArquivoInvalido, ConversaoFalhou,
    chave_de_miniatura, chave_de_saida, converter_foto, converter_video,
)
from worker import processar  # noqa: E402


def tem_ffmpeg() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


precisa_ffmpeg = pytest.mark.skipif(not tem_ffmpeg(), reason="ffmpeg nao instalado")


@pytest.fixture
def video(tmp_path: Path) -> Path:
    """Vídeo de 2 s gerado na hora pelo próprio FFmpeg."""
    destino = tmp_path / "entrada.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=640x480:rate=15",
         "-pix_fmt", "yuv420p", str(destino)],
        capture_output=True, check=True,
    )
    return destino


# ── separação de prefixo ─────────────────────────────────────────────

def test_saida_vai_para_processados():
    assert chave_de_saida("originais/eq1/m1.mp4", "m1") == "processados/m1.mp4"


def test_a_chave_usa_o_id_da_midia_e_nao_o_nome_original():
    """Nome estável é o que torna a regravação idempotente: refazer o
    trabalho sobrescreve o mesmo objeto em vez de criar órfão."""
    a = chave_de_saida("originais/eq1/qualquer-coisa.mp4", "m1")
    b = chave_de_saida("originais/eq1/outro-nome.mp4", "m1")
    assert a == b


def test_recusa_chave_fora_de_originais():
    """Converter algo que já está em processados/ seria o laço que a
    separação por prefixo existe para impedir."""
    with pytest.raises(ArquivoInvalido):
        chave_de_saida("processados/m1.mp4", "m1")


def test_miniatura_tem_chave_propria():
    assert chave_de_miniatura("m1") == "processados/m1-miniatura.jpg"


# ── conversão de verdade ─────────────────────────────────────────────

@precisa_ffmpeg
def test_converte_video_e_gera_miniatura(video: Path, tmp_path: Path):
    saida = tmp_path / "saida.mp4"
    mini = tmp_path / "mini.jpg"

    r = converter_video(video, saida, mini)

    assert saida.exists() and saida.stat().st_size > 0
    assert mini.exists() and mini.stat().st_size > 0
    assert r.duracao_s == pytest.approx(2.0, abs=0.5)


@precisa_ffmpeg
def test_converte_sem_miniatura_quando_nao_pedida(video: Path, tmp_path: Path):
    r = converter_video(video, tmp_path / "s.mp4")
    assert r.chave_miniatura is None


@precisa_ffmpeg
def test_arquivo_corrompido_nao_vale_repetir(tmp_path: Path):
    """Distinguir isto de falha temporária evita gastar as três
    tentativas do RF-010 num arquivo que nunca vai converter."""
    ruim = tmp_path / "ruim.mp4"
    ruim.write_bytes(b"isto nao e um video" * 50)

    with pytest.raises(ArquivoInvalido):
        converter_video(ruim, tmp_path / "s.mp4")


def test_ffmpeg_ausente_e_falha_temporaria(tmp_path: Path, monkeypatch):
    """Imagem sem FFmpeg é problema de implantação, não do arquivo:
    repetir faz sentido depois que a imagem for corrigida."""
    def sem_ffmpeg(*a, **k):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(subprocess, "run", sem_ffmpeg)
    with pytest.raises(ConversaoFalhou):
        converter_foto(tmp_path / "x.jpg", tmp_path / "y.jpg")


# ── worker ───────────────────────────────────────────────────────────

class ArmazenamentoFalso:
    def __init__(self, conteudo: bytes = b""):
        self.conteudo = conteudo
        self.enviados: dict[str, bytes] = {}

    def baixar(self, chave: str, destino: Path) -> None:
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(self.conteudo)

    def enviar(self, origem: Path, chave: str) -> None:
        self.enviados[chave] = origem.read_bytes()


@precisa_ffmpeg
def test_worker_converte_envia_e_publica(video: Path):
    arm = ArmazenamentoFalso(video.read_bytes())
    publicados = []

    r = processar(
        {"id_midia": "m1", "chave_original": "originais/eq1/v.mp4", "tipo": "video"},
        armazenamento=arm, publicar=publicados.append,
    )

    assert r["status"] == "pronta"
    assert "processados/m1.mp4" in arm.enviados
    assert "processados/m1-miniatura.jpg" in arm.enviados

    assert len(publicados) == 1
    assert publicados[0]["chave_processada"] == "processados/m1.mp4"
    assert publicados[0]["erro"] is None


@precisa_ffmpeg
def test_worker_publica_a_falha_de_arquivo_invalido():
    """O CAT precisa saber que falhou — senão a mídia fica em
    `na_fila` para sempre e ninguém entende por quê."""
    arm = ArmazenamentoFalso(b"nao e video" * 50)
    publicados = []

    r = processar(
        {"id_midia": "m2", "chave_original": "originais/eq1/v.mp4", "tipo": "video"},
        armazenamento=arm, publicar=publicados.append,
    )

    assert r["status"] == "erro"
    assert r["repetir"] is False
    assert publicados[0]["erro"] is not None
    assert publicados[0]["chave_processada"] is None
    assert arm.enviados == {}, "nada pode ter sido enviado"


@precisa_ffmpeg
def test_worker_publica_depois_de_enviar(video: Path):
    """A ordem é a garantia: publicar antes de enviar diria ao CAT que a
    mídia está pronta quando o arquivo ainda não existe."""
    ordem = []

    class Espiao(ArmazenamentoFalso):
        def enviar(self, origem: Path, chave: str) -> None:
            ordem.append(f"enviou:{chave}")
            super().enviar(origem, chave)

    arm = Espiao(video.read_bytes())
    processar(
        {"id_midia": "m3", "chave_original": "originais/eq1/v.mp4", "tipo": "video"},
        armazenamento=arm, publicar=lambda c: ordem.append("publicou"),
    )

    assert ordem[-1] == "publicou"
    assert any(p.startswith("enviou:") for p in ordem[:-1])
