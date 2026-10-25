"""Conversão de mídia com FFmpeg (RF-009, RF-010).

Único serviço em Python, pela ADR-002: o ganho não é o FFmpeg em si — ele
converte igual em qualquer linguagem — e sim o acesso a quadro e metadado
por biblioteca, que a geração de miniatura aproveita.
"""

from __future__ import annotations

import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger("mid")

# Tempo máximo por arquivo. O RNF-005 exige vídeo disponível em menos de
# 5 minutos; o limite aqui é menor para sobrar margem de fila e upload.
LIMITE_SEGUNDOS = 240


class ConversaoFalhou(Exception):
    """Falha que vale repetir: o worker devolve a mensagem à fila."""


class ArquivoInvalido(Exception):
    """Arquivo que não melhora com repetição — vai direto para a DLQ."""


@dataclass
class Resultado:
    chave_processada: str
    chave_miniatura: str | None
    duracao_s: float | None


def _rodar(args: list[str]) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            args, capture_output=True, text=True,
            timeout=LIMITE_SEGUNDOS, check=True,
        )
    except subprocess.TimeoutExpired as e:
        raise ConversaoFalhou(f"excedeu {LIMITE_SEGUNDOS}s") from e
    except FileNotFoundError as e:
        raise ConversaoFalhou("ffmpeg nao encontrado na imagem") from e
    except subprocess.CalledProcessError as e:
        erro = (e.stderr or "")[-300:]
        # Arquivo corrompido ou formato que o FFmpeg não entende não
        # melhora na segunda tentativa; distinguir isso evita gastar as
        # três tentativas do RF-010 à toa.
        if "Invalid data found" in erro or "moov atom not found" in erro:
            raise ArquivoInvalido(erro) from e
        raise ConversaoFalhou(erro) from e


def duracao(origem: Path) -> float | None:
    """Duração em segundos, pelo ffprobe. None quando não dá para saber."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(origem)],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return float(r.stdout.strip())
    except (subprocess.SubprocessError, ValueError, FileNotFoundError):
        return None


def converter_video(origem: Path, destino: Path, miniatura: Path | None = None) -> Resultado:
    """Gera versão web e, opcionalmente, a miniatura.

    A saída é **nomeada de forma estável pelo id da mídia**, e não por
    timestamp ou aleatório. Isso torna a regravação idempotente: se o
    worker cair depois de gravar e antes de confirmar, refazer sobrescreve
    o mesmo objeto em vez de criar um órfão (arquitetura, §3.4).
    """
    destino.parent.mkdir(parents=True, exist_ok=True)

    _rodar([
        "ffmpeg", "-y", "-i", str(origem),
        "-vcodec", "libx264", "-crf", "28", "-preset", "fast",
        "-vf", "scale='min(1280,iw)':-2",   # não aumenta vídeo pequeno
        "-acodec", "aac", "-b:a", "128k",
        "-movflags", "+faststart",          # começa a tocar antes de baixar tudo
        str(destino),
    ])

    chave_min = None
    if miniatura is not None:
        miniatura.parent.mkdir(parents=True, exist_ok=True)
        _rodar([
            "ffmpeg", "-y", "-i", str(origem),
            "-ss", "00:00:01", "-vframes", "1",
            "-vf", "scale=400:-2", str(miniatura),
        ])
        chave_min = str(miniatura)

    return Resultado(str(destino), chave_min, duracao(origem))


def converter_foto(origem: Path, destino: Path) -> Resultado:
    """Comprime a foto e limita a largura."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    _rodar([
        "ffmpeg", "-y", "-i", str(origem),
        "-vf", "scale='min(1600,iw)':-2", "-q:v", "3",
        str(destino),
    ])
    return Resultado(str(destino), None, None)


def chave_de_saida(chave_original: str, id_midia: str) -> str:
    """Traduz originais/... para processados/...

    O prefixo separado é o que impede o laço: a notificação do S3 escuta
    só `originais/`, então gravar o derivado em `processados/` não dispara
    uma nova conversão (DFD, decisão 5).
    """
    if not chave_original.startswith("originais/"):
        raise ArquivoInvalido(f"chave fora de originais/: {chave_original}")
    sufixo = Path(chave_original).suffix
    return f"processados/{id_midia}{sufixo}"


def chave_de_miniatura(id_midia: str) -> str:
    return f"processados/{id_midia}-miniatura.jpg"
