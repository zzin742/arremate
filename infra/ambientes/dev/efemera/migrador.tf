# Tarefa avulsa que cria os bancos e aplica as migrations.
#
# No compose, `db/init/00-bancos.sql` roda sozinho porque o Postgres em
# contêiner executa o que estiver em `docker-entrypoint-initdb.d` na
# primeira subida. O RDS não tem esse gancho: nasce com um `postgres`
# vazio. Sem esta tarefa, os serviços sobem, passam no health check e
# devolvem erro interno em toda rota que toca no banco — foi o que
# aconteceu na estreia.
#
# É tarefa avulsa, e não um passo no start de cada serviço, porque cada
# serviço subiria a sua migration em paralelo com as réplicas dele e com
# os outros seis. Uma execução, um lugar, uma ordem.
#
# A imagem é a do AUTH só porque alguma precisa ser escolhida: as sete
# carregam `db/migrar.js` e as migrations de todos os bancos.

resource "aws_cloudwatch_log_group" "migrador" {
  name              = "/ecs/${local.nome}/migrador"
  retention_in_days = 7
}

resource "aws_ecs_task_definition" "migrador" {
  family                   = "${local.nome}-migrador"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512

  execution_role_arn = data.aws_iam_role.lab.arn
  task_role_arn      = data.aws_iam_role.lab.arn

  container_definitions = jsonencode([{
    name    = "migrador"
    image   = "${data.terraform_remote_state.persistente.outputs.repositorios["auth"]}:${var.imagem_tag}"
    command = ["node", "db/migrar.js"]

    # Sem PGDATABASE: o migrador abre uma conexão por banco e começa
    # pelo `postgres`, que é onde o CREATE DATABASE tem de rodar.
    environment = [
      { name = "PGHOST", value = aws_db_instance.principal.address },
      { name = "PGUSER", value = "arremate" },
      { name = "PGSSL", value = "exigir" },
      { name = "NODE_ENV", value = "production" },
    ]

    secrets = [
      { name = "PGPASSWORD", valueFrom = aws_ssm_parameter.senha_banco.arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.migrador.name
        "awslogs-region"        = var.regiao
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

# O que o deploy precisa para disparar a tarefa sem adivinhar nomes.
output "migrador" {
  value = {
    tarefa    = aws_ecs_task_definition.migrador.family
    subredes  = aws_subnet.aplicacao[*].id
    seguranca = aws_security_group.ecs.id
  }
}
