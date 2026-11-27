# Prometheus e Grafana no ECS (RNF-021).
#
# Ficam na camada EFÊMERA, não na persistente: são duas tarefas Fargate
# e é a efêmera que sobe e desce com a sessão de trabalho. O histórico
# morre com o ambiente — manter série temporal entre sessões exigiria
# EFS ligado o tempo todo, e o critério pede os painéis no ar, não o
# histórico preservado.
#
# ## Como o Prometheus acha os serviços
#
# Por DNS do Cloud Map, não pelo ALB. Raspar `/api/lei/metricas` pelo
# ALB pareceria mais simples e estaria errado: o LEI roda com 2 tarefas,
# o ALB sorteia uma a cada chamada, e as séries sairiam de instâncias
# diferentes a cada raspagem — o contador cairia e subiria sem nada ter
# acontecido. O `dns_sd_configs` resolve o nome e recebe **todos** os
# IPs, uma série por tarefa.
#
# ## Como a configuração chega lá dentro
#
# Escrita pelo próprio entrypoint, com `printf`. As alternativas eram
# montar EFS (um recurso novo, pago, só para dois arquivos de texto) ou
# construir imagem própria (um repositório no ECR e um build no CI para
# cada mudança de painel). Para arquivo de configuração estático, o
# entrypoint é o caminho mais curto que não arrasta infraestrutura.

# ── Service discovery ──────────────────────────────────────────────────

resource "aws_service_discovery_private_dns_namespace" "interno" {
  name = "${local.nome}.local"
  vpc  = aws_vpc.principal.id
}

resource "aws_service_discovery_service" "servico" {
  for_each = local.servicos
  name     = each.key

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.interno.id

    # TTL curto: tarefa Fargate troca de IP a cada implantação, e um TTL
    # longo deixaria o Prometheus raspando endereço morto.
    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE" # devolve todos os IPs, não um sorteado
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# ── Prometheus ─────────────────────────────────────────────────────────

locals {
  # Um alvo por serviço, pelo nome do Cloud Map. O `servico` vem daqui e
  # não da aplicação: posto nos dois lados, o Prometheus renomeia o da
  # aplicação para `exported_servico` (ver infra/observabilidade).
  alvos_prometheus = join("\n", [
    for nome, cfg in local.servicos : <<-ALVO
      - job_name: ${nome}
        metrics_path: /metricas
        dns_sd_configs:
          - names: ['${nome}.${aws_service_discovery_private_dns_namespace.interno.name}']
            type: A
            port: ${cfg.porta}
        relabel_configs:
          - target_label: servico
            replacement: ${nome}
    ALVO
  ])

  prometheus_yml = <<-YML
    global:
      scrape_interval: 15s
      scrape_timeout: 10s
    scrape_configs:
    ${local.alvos_prometheus}
  YML
}

resource "aws_cloudwatch_log_group" "observabilidade" {
  for_each          = toset(["prometheus", "grafana"])
  name              = "/ecs/${local.nome}/${each.key}"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "prometheus" {
  family                   = "${local.nome}-prometheus"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = data.aws_iam_role.lab.arn
  task_role_arn            = data.aws_iam_role.lab.arn

  container_definitions = jsonencode([{
    name  = "prometheus"
    image = "prom/prometheus:v2.54.1"

    # `base64` para o YAML atravessar a definição da tarefa sem que
    # aspas, dois-pontos e indentação sejam reinterpretados por JSON e
    # pelo shell no caminho. Arquivo de configuração com indentação
    # significativa não sobrevive a `printf` direto.
    entryPoint = ["/bin/sh", "-c"]
    command = [
      "echo '${base64encode(local.prometheus_yml)}' | base64 -d > /etc/prometheus/prometheus.yml && exec /bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus --web.enable-lifecycle"
    ]

    portMappings = [{ containerPort = 9090, protocol = "tcp" }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.observabilidade["prometheus"].name
        "awslogs-region"        = var.regiao
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

resource "aws_service_discovery_service" "prometheus" {
  name = "prometheus"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.interno.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_service" "prometheus" {
  name            = "prometheus"
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.prometheus.arn
  desired_count   = var.sessao_ativa ? 1 : 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.aplicacao[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.prometheus.arn
  }
}

# ── Grafana ────────────────────────────────────────────────────────────

locals {
  # Fonte de dados provisionada: sem isso o Grafana sobe vazio e alguém
  # precisa ligá-lo ao Prometheus na mão a cada ambiente novo.
  grafana_datasource = <<-YML
    apiVersion: 1
    datasources:
      - name: Prometheus
        type: prometheus
        access: proxy
        url: http://prometheus.${aws_service_discovery_private_dns_namespace.interno.name}:9090
        isDefault: true
        uid: prometheus
  YML
}

resource "aws_ecs_task_definition" "grafana" {
  family                   = "${local.nome}-grafana"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = data.aws_iam_role.lab.arn
  task_role_arn            = data.aws_iam_role.lab.arn

  container_definitions = jsonencode([{
    name  = "grafana"
    image = "grafana/grafana:11.2.0"

    entryPoint = ["/bin/sh", "-c"]
    command = [
      "mkdir -p /etc/grafana/provisioning/datasources && echo '${base64encode(local.grafana_datasource)}' | base64 -d > /etc/grafana/provisioning/datasources/ds.yml && exec /run.sh"
    ]

    environment = [
      # O painel vive atrás do ALB em /grafana; sem a raiz declarada, os
      # links que o Grafana gera apontam para / e quebram.
      { name = "GF_SERVER_ROOT_URL", value = "http://${aws_lb.principal.dns_name}/grafana" },
      { name = "GF_SERVER_SERVE_FROM_SUB_PATH", value = "true" },

      # Sem login na defesa: ambiente de demonstração, sem dado real.
      # Em produção isto seria inaceitável — está aqui porque o
      # ambiente é descartável e o ALB é interno ao lab.
      { name = "GF_AUTH_ANONYMOUS_ENABLED", value = "true" },
      { name = "GF_AUTH_ANONYMOUS_ORG_ROLE", value = "Admin" },
      { name = "GF_AUTH_DISABLE_LOGIN_FORM", value = "true" },
    ]

    portMappings = [{ containerPort = 3000, protocol = "tcp" }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.observabilidade["grafana"].name
        "awslogs-region"        = var.regiao
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

resource "aws_lb_target_group" "grafana" {
  name        = "${local.nome}-grafana"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.principal.id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
  }
}

resource "aws_lb_listener_rule" "grafana" {
  listener_arn = aws_lb_listener.https.arn

  # `/grafana*` não colide com `/api/*`, então a ordem não decide nada
  # aqui; a prioridade só precisa ser única. As regras de serviço
  # começam em 10 para esta ficar livre.
  priority = 1

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.grafana.arn
  }

  condition {
    path_pattern { values = ["/grafana", "/grafana/*"] }
  }
}

resource "aws_ecs_service" "grafana" {
  name            = "grafana"
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.grafana.arn
  desired_count   = var.sessao_ativa ? 1 : 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.aplicacao[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.grafana.arn
    container_name   = "grafana"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener_rule.grafana]
}

output "url_grafana" {
  value = "http://${aws_lb.principal.dns_name}/grafana"
}
