# CAMADA 1 — Bootstrap. State LOCAL, versionado no repositório.
#
# Resolve o ovo e a galinha: o backend remoto precisa existir antes do
# primeiro `init` das outras camadas. Criar o bucket pela CLI abriria
# exceção ao RNF-022 ("zero recursos criados manualmente"), então aqui é
# Terraform também — só que com state local.
#
# O state desta camada tem poucos recursos e nenhum segredo, então
# versioná-lo é aceitável. Ela NUNCA entra na rotina de destroy.

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

variable "regiao" {
  type    = string
  default = "us-east-1"
}

variable "prefixo" {
  type        = string
  default     = "arremate"
  description = "Prefixo dos recursos; o bucket de state precisa de nome unico globalmente"
}

data "aws_caller_identity" "atual" {}

# ── Por que awscc e nao aws_s3_bucket ──────────────────────────────────
#
# O Learner Lab roda sob uma Service Control Policy que NEGA
# `s3:GetBucketObjectLockConfiguration`. O recurso `aws_s3_bucket` chama
# essa API em toda leitura, inclusive logo apos criar — então o bucket
# nascia e o apply quebrava em seguida com AccessDenied. Testei nas
# versoes 5.100 e 6.70 do provider; as duas fazem a chamada.
#
# O provider `awscc` usa a API Cloud Control, que nao passa por ali.
# Mesma infraestrutura, caminho diferente até ela.
#
# O BACKEND continua sendo o S3 normal: escrever e ler objeto de state
# usa PutObject e GetObject, que a SCP nao bloqueia. O problema era so
# o recurso, nunca o armazenamento.
resource "awscc_s3_bucket" "state" {
  bucket_name = "${var.prefixo}-tfstate-${data.aws_caller_identity.atual.account_id}"

  versioning_configuration = {
    status = "Enabled"
  }

  bucket_encryption = {
    server_side_encryption_configuration = [{
      server_side_encryption_by_default = {
        sse_algorithm = "AES256"
      }
    }]
  }

  public_access_block_configuration = {
    block_public_acls       = true
    block_public_policy     = true
    ignore_public_acls      = true
    restrict_public_buckets = true
  }

  lifecycle {
    prevent_destroy = true
  }
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

output "bucket_state" { value = awscc_s3_bucket.state.bucket_name }
output "tabela_lock" { value = aws_dynamodb_table.lock.name }
