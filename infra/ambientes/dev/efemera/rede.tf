# Rede da camada efêmera.
#
# Três camadas de sub-rede, e o tráfego só desce: a internet alcança a
# pública, a pública alcança a de aplicação, a de aplicação alcança a de
# dados. O caminho inverso não existe (doc 05, §4.1).

data "aws_availability_zones" "disponiveis" {
  state = "available"
}

resource "aws_vpc" "principal" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = local.nome }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.principal.id
  tags   = { Name = local.nome }
}

# ── Sub-redes ──────────────────────────────────────────────────────────
resource "aws_subnet" "publica" {
  count                   = 2
  vpc_id                  = aws_vpc.principal.id
  cidr_block              = "10.0.${count.index + 1}.0/24"
  availability_zone       = data.aws_availability_zones.disponiveis.names[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${local.nome}-publica-${count.index + 1}" }
}

resource "aws_subnet" "aplicacao" {
  count             = 2
  vpc_id            = aws_vpc.principal.id
  cidr_block        = "10.0.${count.index + 11}.0/24"
  availability_zone = data.aws_availability_zones.disponiveis.names[count.index]
  tags              = { Name = "${local.nome}-aplicacao-${count.index + 1}" }
}

resource "aws_subnet" "dados" {
  count             = 2
  vpc_id            = aws_vpc.principal.id
  cidr_block        = "10.0.${count.index + 21}.0/24"
  availability_zone = data.aws_availability_zones.disponiveis.names[count.index]
  tags              = { Name = "${local.nome}-dados-${count.index + 1}" }
}

# ── NAT ────────────────────────────────────────────────────────────────
# Um só, não um por AZ. É o maior custo fixo depois do Fargate, e a
# redundância não se paga num ambiente que é destruído toda sessão. O
# risco está declarado no doc 05, §3.3: se esta AZ cair, as tarefas
# perdem saída para a internet.
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.nome}-nat" }
}

resource "aws_nat_gateway" "nat" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.publica[0].id
  depends_on    = [aws_internet_gateway.igw]
  tags          = { Name = local.nome }
}

# ── Rotas ──────────────────────────────────────────────────────────────
resource "aws_route_table" "publica" {
  vpc_id = aws_vpc.principal.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
  tags = { Name = "${local.nome}-publica" }
}

resource "aws_route_table" "aplicacao" {
  vpc_id = aws_vpc.principal.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat.id
  }
  tags = { Name = "${local.nome}-aplicacao" }
}

# A de dados NÃO tem rota para fora. Banco não inicia conexão com a
# internet; se precisasse, seria sinal de que algo está no lugar errado.
resource "aws_route_table" "dados" {
  vpc_id = aws_vpc.principal.id
  tags   = { Name = "${local.nome}-dados" }
}

resource "aws_route_table_association" "publica" {
  count          = 2
  subnet_id      = aws_subnet.publica[count.index].id
  route_table_id = aws_route_table.publica.id
}

resource "aws_route_table_association" "aplicacao" {
  count          = 2
  subnet_id      = aws_subnet.aplicacao[count.index].id
  route_table_id = aws_route_table.aplicacao.id
}

resource "aws_route_table_association" "dados" {
  count          = 2
  subnet_id      = aws_subnet.dados[count.index].id
  route_table_id = aws_route_table.dados.id
}
