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

for t in conta-criada agendamento-criado agendamento-cancelado \
         atendimento-concluido expediente-mudou pagamento-confirmado; do
  criar_topico "$t"
done
for f in bar-conta-criada agd-espelhar-expediente notificacao-enviar \
         ass-descontar-uso ava-liberar-avaliacao; do
  criar_fila "$f"
done

echo "assinaturas:"
assinar conta-criada           bar-conta-criada
assinar expediente-mudou       agd-espelhar-expediente
assinar agendamento-criado     notificacao-enviar
assinar agendamento-cancelado  notificacao-enviar
assinar atendimento-concluido  notificacao-enviar
assinar atendimento-concluido  ass-descontar-uso
assinar atendimento-concluido  ava-liberar-avaliacao
assinar pagamento-confirmado   notificacao-enviar

awslocal s3 mb s3://naregua-fotos >/dev/null 2>&1 || true
echo "mensageria local pronta"
