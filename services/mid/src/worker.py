"""Worker: consome a fila, converte e devolve o resultado por evento."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from conversao import (
    ArquivoInvalido, ConversaoFalhou,
    chave_de_miniatura, chave_de_saida, converter_foto, converter_video,
)

log = logging.getLogger("mid")


def processar(mensagem: dict, *, armazenamento, publicar) -> dict:
    """Converte uma mídia.

    A ordem aqui importa, e é a mesma regra do CAT (arquitetura, §3.4):
    o worker grava o derivado, **publica o resultado**, e só então quem
    chamou apaga a mensagem da fila. Apagar antes abriria janela de
    perda; cair entre gravar e publicar refaz o trabalho, o que é
    aceitável porque a saída é nomeada pelo id da mídia e a regravação
    sobrescreve o mesmo objeto.
    """
    id_midia = mensagem["id_midia"]
    chave_original = mensagem["chave_original"]
    tipo = mensagem.get("tipo", "video")

    with tempfile.TemporaryDirectory() as tmp:
        pasta = Path(tmp)
        origem = pasta / Path(chave_original).name
        armazenamento.baixar(chave_original, origem)

        saida = chave_de_saida(chave_original, id_midia)
        destino = pasta / Path(saida).name

        try:
            if tipo == "video":
                mini_chave = chave_de_miniatura(id_midia)
                r = converter_video(origem, destino, pasta / Path(mini_chave).name)
            else:
                mini_chave = None
                r = converter_foto(origem, destino)
        except ArquivoInvalido as e:
            # não adianta repetir: publica a falha para o CAT registrar
            log.warning("arquivo invalido %s: %s", id_midia, e)
            publicar({"id_midia": id_midia, "chave_processada": None, "erro": str(e)[:200]})
            return {"id_midia": id_midia, "status": "erro", "repetir": False}

        armazenamento.enviar(destino, saida)
        if r.chave_miniatura:
            armazenamento.enviar(Path(r.chave_miniatura), mini_chave)

        publicar({
            "id_midia": id_midia,
            "chave_processada": saida,
            "chave_miniatura": mini_chave,
            "duracao_s": r.duracao_s,
            "erro": None,
        })
        return {"id_midia": id_midia, "status": "pronta", "repetir": False}


class ArmazenamentoS3:
    def __init__(self, bucket: str | None = None, cliente=None):
        import boto3
        self.bucket = bucket or os.environ.get("BUCKET_MIDIA", "arremate-midia")
        self.s3 = cliente or boto3.client(
            "s3",
            endpoint_url=os.environ.get("AWS_ENDPOINT", "http://localhost:4566"),
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            aws_access_key_id="test", aws_secret_access_key="test",
        )

    def baixar(self, chave: str, destino: Path) -> None:
        destino.parent.mkdir(parents=True, exist_ok=True)
        self.s3.download_file(self.bucket, chave, str(destino))

    def enviar(self, origem: Path, chave: str) -> None:
        self.s3.upload_file(str(origem), self.bucket, chave)


def main() -> None:  # pragma: no cover — ponto de entrada
    import boto3

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    fila = os.environ["FILA_CONVERSAO"]
    topico = os.environ["TOPICO_CONVERTIDA"]

    sqs = boto3.client("sqs", endpoint_url=os.environ.get("AWS_ENDPOINT"),
                       region_name=os.environ.get("AWS_REGION", "us-east-1"))
    sns = boto3.client("sns", endpoint_url=os.environ.get("AWS_ENDPOINT"),
                       region_name=os.environ.get("AWS_REGION", "us-east-1"))
    armazenamento = ArmazenamentoS3()

    def publicar(corpo: dict) -> None:
        sns.publish(TopicArn=topico, Message=json.dumps(corpo))

    log.info("mid consumindo %s", fila)
    while True:
        r = sqs.receive_message(QueueUrl=fila, MaxNumberOfMessages=1, WaitTimeSeconds=10)
        for msg in r.get("Messages", []):
            envelope = json.loads(msg["Body"])
            corpo = json.loads(envelope["Message"]) if envelope.get("Type") == "Notification" else envelope
            try:
                processar(corpo, armazenamento=armazenamento, publicar=publicar)
            except ConversaoFalhou as e:
                # não apaga: volta à fila e, após 3 recebimentos, vai à DLQ
                log.error("falha temporaria em %s: %s", corpo.get("id_midia"), e)
                continue
            sqs.delete_message(QueueUrl=fila, ReceiptHandle=msg["ReceiptHandle"])


if __name__ == "__main__":  # pragma: no cover
    main()
