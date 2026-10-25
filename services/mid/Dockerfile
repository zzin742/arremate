# Worker de mídia. Única imagem Python do projeto (ADR-002).
#
# A base é a slim do Debian, e não a alpine: o FFmpeg na alpine depende de
# musl e tem histórico de faltar codec. Aqui a imagem fica maior e o vídeo
# converte.
FROM python:3.12-slim

WORKDIR /app

# ffmpeg traz o ffprobe junto, que é quem mede a duração
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY services/mid/pyproject.toml ./
RUN pip install --no-cache-dir boto3 'psycopg[binary]'

COPY services/mid/src/ ./src/

# Não roda como root
RUN useradd --create-home --uid 10001 mid
USER mid

ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/src

# O MID é worker, não serve HTTP: ele consome fila. O health check do ECS
# verifica que o processo está vivo, não uma rota.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import sys; sys.exit(0)"

CMD ["python", "src/worker.py"]
