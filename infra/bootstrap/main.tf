# CAMADA 1 — Bootstrap. State LOCAL, versionado no repositório.
#
# Resolve o problema do ovo e da galinha: o backend remoto precisa existir
# antes do primeiro `init` das outras camadas. A alternativa seria criar o
# bucket pela CLI, o que abriria exceção ao RNF-022 ("zero recursos criados
# manualmente"). Aqui é Terraform também, só que com state local.
#
# O state desta camada tem dois recursos e nenhum segredo, então versioná-lo
# é aceitável. Ela NUNCA entra na rotina de destroy das sessões.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.regiao
}

variable "regiao" {
  type    = string
  default = "us-east-1"
}

variable "prefixo" {
  type        = string
  default     = "arremate"
  description = "Prefixo dos recursos; o bucket de state precisa de nome único globalmente"
}

data "aws_caller_identity" "atual" {}

resource "aws_s3_bucket" "state" {
  bucket = "${var.prefixo}-tfstate-${data.aws_caller_identity.atual.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "lock" {
  name         = "${var.prefixo}-tflock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "bucket_state" { value = aws_s3_bucket.state.id }
output "tabela_lock" { value = aws_dynamodb_table.lock.name }
