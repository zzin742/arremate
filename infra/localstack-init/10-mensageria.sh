#!/bin/bash
# Tópicos, filas, DLQs e ASSINATURAS do inventário (doc 05, §3.4).
set -e
Q=http://localhost:4566/000000000000

criar_fila() {   # $1 = nome
  awslocal sqs create-queue --queue-name "$1-dlq" >/dev/null
  ARN=$(awslocal sqs get-queue-attributes --queue-url "$Q/$1-dlq" \
        --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
  # DLQ de CONSUMO: após 3 recebimentos sem sucesso (RF-010)
  awslocal sqs create-queue --queue-name "$1" \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" >/dev/null
  echo "  fila $1 (+ DLQ)"
}

criar_topico() { awslocal sns create-topic --name "$1" >/dev/null; echo "  tópico $1"; }

assinar() {      # $1 = tópico, $2 = fila
  TARN=$(awslocal sns list-topics --query "Topics[?ends_with(TopicArn,':$1')].TopicArn" --output text)
  QARN=$(awslocal sqs get-queue-attributes --queue-url "$Q/$2" \
         --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
  awslocal sns subscribe --topic-arn "$TARN" --protocol sqs --notification-endpoint "$QARN" >/dev/null
  echo "  $1 -> $2"
}

for t in conta-criada midia-enviada midia-convertida lance-superado leilao-encerrado leilao-liquidar; do
  criar_topico "$t"
done
for f in habilitacao-verificar midia-upload-concluido midia-converter \
         catalogo-atualizar-midia notificacao-enviar caucao-liquidar; do
  criar_fila "$f"
done

echo "assinaturas:"
assinar conta-criada      habilitacao-verificar
assinar midia-enviada     midia-converter
assinar midia-convertida  catalogo-atualizar-midia
assinar lance-superado    notificacao-enviar
assinar leilao-encerrado  notificacao-enviar
assinar leilao-liquidar   caucao-liquidar
# midia-upload-concluido não assina tópico: ela recebe a notificação do S3
# direto, porque o S3 não entrega a contêiner (doc 05, §3.5)

awslocal s3 mb s3://arremate-midia >/dev/null 2>&1 || true
echo "mensageria local pronta"
