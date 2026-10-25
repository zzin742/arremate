# ECS Fargate, ALB e CloudFront.
#
# A entrada é o CloudFront, com S3 e ALB como origens. O desenho anterior
# punha o ALB na frente roteando para o CloudFront, e isso simplesmente
# não existe: alvo de ALB é IP, instância ou Lambda — distribuição do
# CloudFront não pode ser alvo (ADR-011).

resource "aws_ecs_cluster" "principal" {
  name = local.nome
}

resource "aws_cloudwatch_log_group" "servico" {
  for_each          = local.servicos
  name              = "/ecs/${local.nome}/${each.key}"
  retention_in_days = 7 # medida de contenção de custo (doc 05, §6.5)
}

resource "aws_ecs_task_definition" "servico" {
  for_each                 = local.servicos
  family                   = "${local.nome}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memoria

  # LabRole nos dois: o Learner Lab não deixa criar role própria
  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = data.aws_iam_role.lab.arn

  container_definitions = jsonencode([{
    name  = each.key
    image = "${data.terraform_remote_state.persistente.outputs.repositorios[each.key]}:${var.imagem_tag}"

    portMappings = [{ containerPort = each.value.porta, protocol = "tcp" }]

    environment = [
      { name = "PORTA", value = tostring(each.value.porta) },
      { name = "PGHOST", value = aws_db_instance.principal.address },
      { name = "PGDATABASE", value = "arremate_${each.key}" },
      { name = "PGUSER", value = "arremate" },
      { name = "REDIS_HOST", value = aws_elasticache_cluster.principal.cache_nodes[0].address },
      { name = "AWS_REGION", value = var.regiao },
      { name = "NODE_ENV", value = "production" },
    ]

    secrets = [
      { name = "PGPASSWORD", valueFrom = aws_ssm_parameter.senha_banco.arn },
      { name = "JWT_SEGREDO", valueFrom = aws_ssm_parameter.jwt_segredo.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.servico[each.key].name
        "awslogs-region"        = var.regiao
        "awslogs-stream-prefix" = "ecs"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${each.value.porta}/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

resource "aws_ssm_parameter" "jwt_segredo" {
  name  = "/${var.prefixo}/${var.ambiente}/jwt"
  type  = "SecureString"
  value = random_password.jwt.result
}

resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "aws_ecs_service" "servico" {
  for_each = local.servicos

  name            = each.key
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.servico[each.key].arn
  launch_type     = "FARGATE"

  # sessao_ativa = false zera tudo. É o passo 2 do encerramento.
  desired_count = var.sessao_ativa ? each.value.tarefas : 0

  # Faz o apply BLOQUEAR até o serviço estabilizar. Não substitui a
  # conferência tarefa a tarefa do roteiro — `wait_for_steady_state`
  # compara quantidade desejada com em execução, e isso não é o mesmo
  # que verificar que cada tarefa chegou a STOPPED (doc 05, §6.4).
  wait_for_steady_state = true

  network_configuration {
    subnets          = aws_subnet.aplicacao[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false # saída pelo NAT
  }

  dynamic "load_balancer" {
    for_each = var.sessao_ativa ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.servico[each.key].arn
      container_name   = each.key
      container_port   = each.value.porta
    }
  }

  depends_on = [aws_lb_listener.https]
}

# ── Balanceador ────────────────────────────────────────────────────────
resource "aws_lb" "principal" {
  name               = "${local.nome}-alb"
  load_balancer_type = "application"
  subnets            = aws_subnet.publica[*].id
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "servico" {
  for_each    = local.servicos
  name        = "${local.nome}-${each.key}"
  port        = each.value.porta
  protocol    = "HTTP"
  vpc_id      = aws_vpc.principal.id
  target_type = "ip" # Fargate com awsvpc registra por IP

  health_check {
    path                = "/saude"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.principal.arn
  port              = 80
  protocol          = "HTTP" # o TLS termina no CloudFront

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ codigo = "rota_desconhecida" })
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "servico" {
  for_each     = local.servicos
  listener_arn = aws_lb_listener.https.arn
  priority     = index(keys(local.servicos), each.key) + 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.servico[each.key].arn
  }

  condition {
    path_pattern { values = ["/api/${each.key}/*"] }
  }
}

# ── CloudFront: a porta única, quando disponível ───────────────────────
#
# O desenho da ADR-011 põe o CloudFront na entrada, com S3 e ALB como
# origens. **O AWS Academy Learner Lab não permite CloudFront** — nem
# `ListDistributions` passa, o que significa que a política de permissão
# do lab não inclui o serviço.
#
# Então a entrada é condicional:
#
#   usar_cloudfront = true   produção: CloudFront -> S3 e ALB
#   usar_cloudfront = false  Learner Lab: ALB direto, sem estático
#
# A diferença é real e não vale esconder: sem CloudFront não há TLS
# gerenciado na borda, nem cache do estático, e o front precisa de outro
# destino. O que o critério de "deploy em nuvem" exige — serviços
# rodando e alcançáveis — o ALB atende sozinho. Registrado na ADR-014.

resource "aws_cloudfront_distribution" "principal" {
  count   = var.usar_cloudfront ? 1 : 0
  enabled = true

  origin {
    domain_name = aws_lb.principal.dns_name
    origin_id   = "alb"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    domain_name              = data.terraform_remote_state.persistente.outputs.bucket_midia_dominio
    origin_id                = "estatico"
    origin_access_control_id = aws_cloudfront_origin_access_control.estatico[0].id
    origin_path              = "/site"
  }

  default_cache_behavior {
    target_origin_id       = "estatico"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.otimizado[0].id
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    # Sem cache nas rotas dinâmicas: servir lance velho seria pior que
    # não ter cache nenhum.
    cache_policy_id          = data.aws_cloudfront_cache_policy.sem_cache[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.tudo_menos_host[0].id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

resource "aws_cloudfront_origin_access_control" "estatico" {
  count                             = var.usar_cloudfront ? 1 : 0
  name                              = "${local.nome}-estatico"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "otimizado" {
  count = var.usar_cloudfront ? 1 : 0
  name  = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "sem_cache" {
  count = var.usar_cloudfront ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "tudo_menos_host" {
  count = var.usar_cloudfront ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}
