# CAMADA 3 — Efêmera. É esta que o `destroy` leva ao fim de cada sessão.
#
# Aqui fica só o que pode nascer de novo: rede, banco, cache, balanceador
# e as tarefas. O que precisa sobreviver está na camada persistente.
#
# Operada por `terraform -chdir=.../efemera`, com state próprio. Nunca por
# `-target=module.efemera`: um diretório chamado `efemera/` NÃO cria esse
# endereço, que exigiria um bloco `module` num módulo pai.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = var.regiao
}

locals {
  nome = "${var.prefixo}-${var.ambiente}"

  # Inventário do doc 05, §3.1. O LEI escala de 2 a 6 porque é o único que
  # vê rajada na janela de disputa; os demais têm carga previsível.
  servicos = {
    auth = { porta = 3001, cpu = 256, memoria = 512, tarefas = 1 }
    hab  = { porta = 3003, cpu = 256, memoria = 512, tarefas = 1 }
    lei  = { porta = 3002, cpu = 512, memoria = 1024, tarefas = 2 }
  }
}

# A camada efêmera LÊ a persistente, nunca o contrário: se fosse o
# inverso, destruir a efêmera pediria para recriar a persistente.
data "terraform_remote_state" "persistente" {
  backend = "s3"
  config = {
    bucket = var.bucket_state
    key    = "dev/persistente.tfstate"
    region = var.regiao
  }
}

# O Learner Lab NÃO permite criar role IAM. A LabRole já existe na conta e
# é a única utilizável — está declarado como restrição no doc 05, §3.6.
data "aws_iam_role" "lab" {
  name = "LabRole"
}

output "url_alb" { value = aws_lb.principal.dns_name }
output "url_cloudfront" {
  value = var.usar_cloudfront ? aws_cloudfront_distribution.principal[0].domain_name : null
}
output "endpoint_banco" { value = aws_db_instance.principal.endpoint }
