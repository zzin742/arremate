#!/bin/bash
# Tópicos, filas e DLQs do inventário da arquitetura (doc 05, §3.4).
set -e
criar_fila() {   # $1 = nome
  awslocal sqs create-queue --queue-name "$1-dlq" >/dev/null
  ARN=$(awslocal sqs get-queue-attributes --queue-url "http://localhost:4566/000000000000/$1-dlq" \
        --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
  awslocal sqs create-queue --queue-name "$1" \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" >/dev/null
  echo "  fila $1 (+ DLQ)"
}
criar_topico() { awslocal sns create-topic --name "$1" >/dev/null; echo "  tópico $1"; }

for t in conta-criada midia-enviada midia-convertida lance-superado leilao-encerrado leilao-liquidar; do criar_topico "$t"; done
for f in habilitacao-verificar midia-upload-concluido midia-converter catalogo-atualizar-midia notificacao-enviar caucao-liquidar; do criar_fila "$f"; done

awslocal s3 mb s3://arremate-midia >/dev/null && echo "  bucket arremate-midia"
echo "mensageria local pronta"
