# RDS e ElastiCache. Camada efêmera: destruídos ao fim da sessão, com o
# estado preservado por snapshot na camada persistente.

resource "aws_db_subnet_group" "principal" {
  name       = "${local.nome}-db"
  subnet_ids = aws_subnet.dados[*].id
}

resource "random_password" "banco" {
  length  = 24
  special = false # alguns caracteres especiais quebram a URL de conexão
}

resource "aws_ssm_parameter" "senha_banco" {
  name  = "/${var.prefixo}/${var.ambiente}/banco/senha"
  type  = "SecureString"
  value = random_password.banco.result
}

resource "aws_db_instance" "principal" {
  identifier     = "${local.nome}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t3.micro"

  allocated_storage = 20
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = "postgres"
  username = "arremate"
  password = random_password.banco.result

  db_subnet_group_name   = aws_db_subnet_group.principal.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # Single-AZ é decisão de custo, com o risco declarado no doc 05, §3.3:
  # se esta AZ cair, o leilão para, porque sem Postgres não há como
  # confirmar lance.
  multi_az = false

  # O estado atravessa a sessão pelo snapshot da camada persistente, não
  # pelo backup automático — que seria destruído junto com a instância.
  backup_retention_period = 0
  skip_final_snapshot     = true

  # Retomada: restaura do snapshot daquela sessão
  snapshot_identifier = var.snapshot_sessao == "" ? null : "${local.nome}-${var.snapshot_sessao}"

  apply_immediately = true
}

resource "aws_elasticache_subnet_group" "principal" {
  name       = "${local.nome}-redis"
  subnet_ids = aws_subnet.dados[*].id
}

resource "aws_elasticache_cluster" "principal" {
  cluster_id           = "${local.nome}-redis"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t3.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.principal.name
  security_group_ids   = [aws_security_group.redis.id]
}
