# Security groups.
#
# Três buracos da primeira versão do desenho foram corrigidos aqui, e os
# três impediriam o próprio sistema de funcionar (doc 05, §4.2):
#
#  1. sg-ecs não aceitava conexão de sg-ecs. Chamada entre serviços — o LEI
#     consultando o CAU — seria bloqueada. Security group NÃO libera
#     tráfego entre membros por padrão; a regra precisa referenciar o
#     próprio grupo.
#  2. sg-alb não tinha saída para o monitoramento, que fica atrás dele.
#  3. sg-monitoramento não tinha saída para a internet, e a tarefa não
#     conseguiria nem puxar a própria imagem do ECR.

resource "aws_security_group" "alb" {
  name        = "${local.nome}-alb"
  description = "Entrada HTTPS vinda do CloudFront"
  vpc_id      = aws_vpc.principal.id
}

resource "aws_security_group" "ecs" {
  name        = "${local.nome}-ecs"
  description = "Tarefas dos servicos"
  vpc_id      = aws_vpc.principal.id
}

resource "aws_security_group" "rds" {
  name        = "${local.nome}-rds"
  description = "PostgreSQL; so aceita do ECS"
  vpc_id      = aws_vpc.principal.id
}

resource "aws_security_group" "redis" {
  name        = "${local.nome}-redis"
  description = "ElastiCache; so aceita do ECS"
  vpc_id      = aws_vpc.principal.id
}

# ── ALB ────────────────────────────────────────────────────────────────
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "CloudFront chega por aqui"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
  description       = "redireciona para 443"
}

resource "aws_vpc_security_group_egress_rule" "alb_para_ecs" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 3000
  to_port                      = 3010
  ip_protocol                  = "tcp"
  description                  = "portas das aplicacoes e do Grafana"
}

# ── ECS ────────────────────────────────────────────────────────────────
resource "aws_vpc_security_group_ingress_rule" "ecs_do_alb" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3010
  ip_protocol                  = "tcp"
}

# O buraco nº 1: sem esta regra, LEI -> CAU não passa.
resource "aws_vpc_security_group_ingress_rule" "ecs_de_si_mesmo" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 3000
  to_port                      = 3010
  ip_protocol                  = "tcp"
  description                  = "chamadas entre servicos"
}

resource "aws_vpc_security_group_egress_rule" "ecs_para_si_mesmo" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 3000
  to_port                      = 3010
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "ecs_para_rds" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "ecs_para_redis" {
  security_group_id            = aws_security_group.ecs.id
  referenced_security_group_id = aws_security_group.redis.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# 443 para fora cobre ECR, SNS, SQS, S3, CloudWatch e a BrasilAPI — todos
# serviços regionais ou externos alcançados por HTTPS.
resource "aws_vpc_security_group_egress_rule" "ecs_https" {
  security_group_id = aws_security_group.ecs.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
  description       = "ECR, SNS, SQS, S3, logs e BrasilAPI"
}

# ── Dados ──────────────────────────────────────────────────────────────
# Nenhuma regra de saída: o banco não inicia conexão.
resource "aws_vpc_security_group_ingress_rule" "rds_do_ecs" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "redis_do_ecs" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}
