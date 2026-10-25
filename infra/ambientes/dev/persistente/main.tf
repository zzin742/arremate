# CAMADA 2 — Persistente. NUNCA entra na rotina de destroy.
#
# Aqui mora tudo que precisa sobreviver ao fim da sessão de trabalho:
# a mídia, as imagens, os snapshots e — o ponto que custou uma revisão
# inteira para ficar claro — AS FILAS.
#
# Fila na camada efêmera perderia mensagem publicada e ainda não consumida:
# o LEI publica `leilao-liquidar`, o SNS confirma, a outbox marca
# `publicado_em`, o CAU ainda não consumiu, e o destroy leva tudo. Na
# retomada o evento não está na fila e o publicador não o reenvia, porque
# ele só seleciona `publicado_em IS NULL`. A caução nunca seria liquidada.
# Ver ADR-010.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws   = { source = "hashicorp/aws", version = "~> 6.0" }
    awscc = { source = "hashicorp/awscc", version = "~> 1.0" }
  }
}

provider "aws" {
  region = var.regiao
}

provider "awscc" {
  region = var.regiao
}

locals {
  nome = "${var.prefixo}-${var.ambiente}"

  # Inventário do documento 05, §3.4. Mantido aqui em vez de espalhado
  # pelos recursos para que o mapa topico -> fila se leia de uma vez.
  topicos = [
    "conta-criada", "midia-enviada", "midia-convertida",
    "lance-superado", "leilao-encerrado", "leilao-liquidar",
  ]

  filas = [
    "habilitacao-verificar", "midia-upload-concluido", "midia-converter",
    "catalogo-atualizar-midia", "notificacao-enviar", "caucao-liquidar",
  ]

  # chave = "topico|fila", para o for_each ter identificador estável que
  # não depende de ARN gerado no apply
  assinaturas = {
    "conta-criada|habilitacao-verificar"        = ["conta-criada", "habilitacao-verificar"]
    "midia-enviada|midia-converter"             = ["midia-enviada", "midia-converter"]
    "midia-convertida|catalogo-atualizar-midia" = ["midia-convertida", "catalogo-atualizar-midia"]
    "lance-superado|notificacao-enviar"         = ["lance-superado", "notificacao-enviar"]
    "leilao-encerrado|notificacao-enviar"       = ["leilao-encerrado", "notificacao-enviar"]
    "leilao-liquidar|caucao-liquidar"           = ["leilao-liquidar", "caucao-liquidar"]
  }

  servicos = ["auth", "hab", "cat", "mid", "lei", "cau", "vis", "not", "web"]
}

# ── Mídia ──────────────────────────────────────────────────────────────
# Pelo provider `awscc`, e não `aws`, pelo mesmo motivo do bootstrap: a
# SCP do Learner Lab nega `s3:GetBucketObjectLockConfiguration`, e o
# recurso `aws_s3_bucket` chama essa API em toda leitura. O bucket
# nascia e o apply quebrava logo depois. O Cloud Control não passa por
# ali. Registrado como ADR-013.
resource "awscc_s3_bucket" "midia" {
  bucket_name = "${local.nome}-midia"

  public_access_block_configuration = {
    block_public_acls       = true
    block_public_policy     = true
    ignore_public_acls      = true
    restrict_public_buckets = true
  }

  lifecycle_configuration = {
    rules = [{
      id     = "expirar-originais"
      status = "Enabled"
      prefix = "originais/"
      # o derivado em processados/ é o que a ficha exibe; guardar o
      # original para sempre só acumula custo
      expiration_in_days = 90
    }]
  }

  lifecycle { prevent_destroy = true }
}

# ── Imagens dos serviços ───────────────────────────────────────────────
resource "aws_ecr_repository" "servico" {
  for_each             = toset(local.servicos)
  name                 = "${local.nome}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  lifecycle { prevent_destroy = true }
}

resource "aws_ecr_lifecycle_policy" "servico" {
  for_each   = aws_ecr_repository.servico
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Imagem sem tag nao serve para nada depois do push seguinte"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
      action       = { type = "expire" }
    }]
  })
}

# ── Mensageria ─────────────────────────────────────────────────────────
resource "aws_sns_topic" "evento" {
  for_each = toset(local.topicos)
  name     = "${local.nome}-${each.key}"
}

# DLQ de CONSUMO: a mensagem chegou na fila e o consumidor não dá conta
resource "aws_sqs_queue" "dlq_consumo" {
  for_each                  = toset(local.filas)
  name                      = "${local.nome}-${each.key}-dlq"
  message_retention_seconds = 1209600 # 14 dias, o máximo
}

resource "aws_sqs_queue" "fila" {
  for_each                   = toset(local.filas)
  name                       = "${local.nome}-${each.key}"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 300

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq_consumo[each.key].arn
    maxReceiveCount     = 3 # RF-010
  })
}

# DLQ de ASSINATURA: o SNS aceitou a publicação e não conseguiu ENTREGAR.
# É falha diferente da de consumo, e sem esta a mensagem é descartada em
# silêncio com a outbox já marcada como publicada (doc 05, §3.4).
resource "aws_sqs_queue" "dlq_assinatura" {
  for_each                  = local.assinaturas
  name                      = "${local.nome}-sub-${replace(each.key, "|", "-")}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sns_topic_subscription" "fila" {
  for_each  = local.assinaturas
  topic_arn = aws_sns_topic.evento[each.value[0]].arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.fila[each.value[1]].arn

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq_assinatura[each.key].arn
  })
}

# sem esta policy o SNS não consegue escrever na fila
resource "aws_sqs_queue_policy" "permitir_sns" {
  for_each  = aws_sqs_queue.fila
  queue_url = each.value.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = each.value.arn
      Condition = {
        ArnLike = { "aws:SourceArn" = "arn:aws:sns:${var.regiao}:*:${local.nome}-*" }
      }
    }]
  })
}

# ── Flag de manutenção ─────────────────────────────────────────────────
# Provisionada aqui, e não criada pela CLI no roteiro de encerramento:
# `put-parameter` CRIA o parâmetro quando ele não existe, e `--overwrite`
# não transforma a chamada em "só atualizar". Com a CLI, cada encerramento
# recriaria o recurso fora do Terraform (doc 05, §6.4).
resource "aws_ssm_parameter" "manutencao" {
  name  = "/${var.prefixo}/${var.ambiente}/manutencao"
  type  = "String"
  value = "inativa"

  lifecycle {
    # o apply não pode reverter o valor que o roteiro de encerramento
    # acabou de escrever
    ignore_changes = [value]
  }
}

# ── Snapshot da sessão ─────────────────────────────────────────────────
# Criado pelo Terraform, com identificador por sessão, e não por
# `aws rds create-db-snapshot`. O recurso espera ficar disponível sozinho,
# o que dispensa o `aws rds wait` do roteiro antigo.
resource "aws_db_snapshot" "sessao" {
  count                  = var.snapshot_sessao == "" ? 0 : 1
  db_instance_identifier = "${local.nome}-db"
  db_snapshot_identifier = "${local.nome}-${var.snapshot_sessao}"
  lifecycle { prevent_destroy = true }
}

output "bucket_midia" { value = awscc_s3_bucket.midia.bucket_name }
output "bucket_midia_dominio" { value = "${awscc_s3_bucket.midia.bucket_name}.s3.${var.regiao}.amazonaws.com" }
output "repositorios" { value = { for k, v in aws_ecr_repository.servico : k => v.repository_url } }
output "topicos" { value = { for k, v in aws_sns_topic.evento : k => v.arn } }
output "filas" { value = { for k, v in aws_sqs_queue.fila : k => v.url } }
output "parametro_manutencao" { value = aws_ssm_parameter.manutencao.name }
