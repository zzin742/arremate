# Desenho de Arquitetura em Nuvem

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Responsável por este documento:** José Henrique Teixeira Luiz (3225002)
**Provedor:** Amazon Web Services
**Versão:** 1.0 — 27/11/2026

---

## 1. Objetivo

Documentar a infraestrutura em nuvem do Na Régua: quais recursos são
provisionados, como se conectam, como a rede é segmentada e quanto isso custa.

Todo o provisionamento é feito por **Terraform**. Nenhum recurso é criado pelo
console — a criação manual é o que torna um ambiente irreprodutível e, no
Learner Lab, impossível de recuperar depois que a sessão expira.

---

## 2. Topologia

```
                        Internet
                            │
                   ┌────────▼────────┐
                   │   CloudFront    │  cliente e painel (estáticos)
                   └────────┬────────┘
                            │
                   ┌────────▼────────┐
                   │       ALB       │  /api/<servico>/*
                   └────────┬────────┘
                            │
    ╔═══════════════════════▼═══════════════════════════════╗
    ║  VPC 10.0.0.0/16                                       ║
    ║                                                        ║
    ║  ┌── subnets públicas (2 AZs) ────────────────────┐    ║
    ║  │  ALB, NAT                                      │    ║
    ║  └────────────────────┬───────────────────────────┘    ║
    ║                       │                                ║
    ║  ┌── subnets privadas (2 AZs) ───────────────────┐     ║
    ║  │                                                │     ║
    ║  │   ECS Fargate                                  │     ║
    ║  │   ┌──────┐ ┌─────┐ ┌─────┐ ┌─────────────┐    │     ║
    ║  │   │ auth │ │ bar │ │ cat │ │ agd  (2–4)  │    │     ║
    ║  │   └──────┘ └─────┘ └─────┘ └─────────────┘    │     ║
    ║  │                                                │     ║
    ║  │   ┌─────────────┐   ┌──────────────┐          │     ║
    ║  │   │  RDS        │   │ ElastiCache  │          │     ║
    ║  │   │  PostgreSQL │   │ Redis        │          │     ║
    ║  │   │  8 bancos   │   └──────────────┘          │     ║
    ║  │   └─────────────┘                             │     ║
    ║  └────────────────────────────────────────────────┘     ║
    ╚════════════════════════════════════════════════════════╝
                            │
              ┌─────────────┼─────────────┐
              │             │             │
          ┌───▼───┐    ┌────▼────┐   ┌────▼────┐
          │  SNS  │───▶│   SQS   │   │   S3    │  fotos
          │tópicos│    │  filas  │   └─────────┘
          └───────┘    └────┬────┘
                            │  DLQ por fila
                       ┌────▼────┐
                       │   DLQ   │
                       └─────────┘
```

---

## 3. Recursos

### 3.1 Computação — ECS Fargate

| Serviço | Porta | CPU | Memória | Tarefas |
|---|---:|---:|---:|---:|
| `auth` | 3001 | 256 | 512 MB | 1 |
| `bar` | 3002 | 256 | 512 MB | 1 |
| `cat` | 3003 | 256 | 512 MB | 1 |
| **`agd`** | 3004 | 512 | 1024 MB | **2 a 4** |

Fargate e não EC2: o Learner Lab não permite criar role IAM, e gerenciar
instância para quatro contêineres pequenos seria trabalho sem retorno.

**Por que o `agd` escala e os demais não.** Ele é o único que vê rajada — todo
mundo marca no mesmo horário de pico, e o sábado de manhã concentra a disputa.
Catálogo e perfil são lidos muito e escritos pouco, e aguentam uma tarefa.

### 3.2 Rede

| Recurso | Configuração | Por quê |
|---|---|---|
| VPC | `10.0.0.0/16` | — |
| Subnets públicas | 2, em AZs diferentes | O ALB exige duas; uma só é ponto único de falha estrutural |
| Subnets privadas | 2, em AZs diferentes | O DB Subnet Group do RDS **recusa** um grupo com uma AZ só |
| Internet Gateway | nas públicas | — |
| NAT Gateway | 1, na pública | Saída das privadas para SNS, SQS e a API do Google |

> **O NAT custa caro e é o maior item da conta.** Alternativa considerada:
> VPC Endpoints para SNS e SQS, dispensando o NAT. Descartada porque a
> integração com o Google Places precisa de internet de verdade, e manter NAT e
> endpoints ao mesmo tempo seria pagar duas vezes pela mesma saída.

### 3.3 Security Groups

| Grupo | Entrada | Saída |
|---|---|---|
| `sg-alb` | 443 de qualquer origem | para `sg-app` |
| `sg-app` | porta do serviço, **somente de `sg-alb`** | irrestrita |
| `sg-db` | 5432, **somente de `sg-app`** | nenhuma |
| `sg-cache` | 6379, **somente de `sg-app`** | nenhuma |

A regra do `sg-db` é por **referência ao security group**, não por CIDR: o IP
privado da tarefa muda a cada implantação, e uma regra por CIDR deixaria de
valer em silêncio.

### 3.4 Mensageria

**Tópicos SNS**

| Tópico | Quem publica |
|---|---|
| `conta-criada` | `auth` |
| `agendamento-criado` | `agd` |
| `agendamento-cancelado` | `agd` |
| `atendimento-concluido` | `agd` |
| `expediente-mudou` | `cat` |
| `pagamento-confirmado` | `pag` |

**Filas SQS**

| Fila | Quem consome | Para quê |
|---|---|---|
| `bar-conta-criada` | `bar` | associar a conta à barbearia quando convidada |
| `agd-espelhar-expediente` | `agd` | manter o espelho local (ADR-005) |
| `notificacao-enviar` | `not` | avisar cliente e barbearia |
| `ass-descontar-uso` | `ass` | descontar o corte do plano |
| `ava-liberar-avaliacao` | `ava` | liberar a avaliação do atendimento |

Cada fila tem **DLQ**. Mensagem que falha repetidamente vai para lá em vez de
voltar para sempre, e a idade da DLQ é métrica no painel.

### 3.5 Dados

| Recurso | Configuração |
|---|---|
| RDS PostgreSQL 16 | `db.t3.micro`, subnets privadas, `publicly_accessible = false` |
| ElastiCache Redis | `cache.t3.micro`, subnets privadas |
| S3 | fotos de barbearia, barbeiro e serviço; acesso público bloqueado |

Oito bancos lógicos numa instância, com um usuário por serviço — ver **ADR-003**
para o que isso custou.

### 3.6 Restrições do AWS Academy Learner Lab

O ambiente da disciplina impõe limites que **mudaram o desenho**, não apenas a
configuração:

| Restrição | Consequência no projeto |
|---|---|
| Nenhuma role IAM pode ser criada | `LabRole` e `LabInstanceProfile` entram por `data source`, nunca por `resource` |
| `aws_s3_bucket` falha na SCP | O bucket é criado pelo provider `awscc`, que não chama `GetBucketObjectLockConfiguration` |
| Sem ACM, CloudFront ou Route53 próprios | O ALB responde em HTTP no ambiente de desenvolvimento |
| Credenciais expiram em 4 horas | Nenhum estado de longa duração pode depender da sessão; o `terraform state` fica em S3 |
| Região fixa | `us-east-1` |

---

## 4. Infraestrutura como Código

Terraform em **três camadas**, com estado separado:

| Camada | O que provisiona | Por que separada |
|---|---|---|
| `bootstrap` | bucket do estado e tabela de lock | Precisa existir antes de qualquer outra |
| `persistente` | S3, ECR, tópicos, filas, DLQs | Destruir a camada efêmera não pode apagar fila com mensagem |
| `efemera` | VPC, ALB, ECS, RDS, ElastiCache | É a que se derruba ao fim do dia para não gastar crédito |

A efêmera **lê** a persistente por `terraform_remote_state`, nunca o contrário:
se fosse o inverso, destruir a efêmera pediria para recriar a persistente.

```bash
cd infra/ambientes/dev/efemera
terraform init
terraform plan
terraform apply
```

---

## 5. Observabilidade

| Camada | Ferramenta |
|---|---|
| Métricas | Prometheus, raspando `/metricas` de cada serviço |
| Painel | Grafana, com dashboard provisionado por arquivo |
| Log | CloudWatch Logs, um grupo por serviço |

O painel é **provisionado por arquivo**, não montado na mão: painel configurado
pelo console se perde quando o ambiente é recriado, e no Learner Lab isso
acontece todo dia.

Métricas expostas por serviço: latência por rota, contagem por status HTTP, e a
**idade da pendência mais antiga da outbox** — é ela que denuncia publicador
parado, que é a falha silenciosa mais perigosa do desenho da ADR-004.

---

## 6. Estimativa de custo

Preços `us-east-1`, novembro de 2026, ambiente de desenvolvimento ligado
**8 h/dia em 22 dias úteis**.

| Recurso | Dimensão | Estimativa |
|---|---|---:|
| ECS Fargate | 5 tarefas médias × 176 h | US$ 14,20 |
| RDS `db.t3.micro` | 176 h | US$ 3,20 |
| ElastiCache `cache.t3.micro` | 176 h | US$ 2,40 |
| ALB | 176 h + LCU | US$ 4,30 |
| **NAT Gateway** | 176 h + tráfego | **US$ 8,40** |
| S3 | 5 GB | US$ 0,12 |
| SNS + SQS | < 1 M requisições | US$ 0,00 (free tier) |
| CloudWatch Logs | 2 GB | US$ 1,00 |
| **Total/mês (8 h/dia)** | | **≈ US$ 33,62** |

Ligado **24/7**, o mesmo ambiente custa cerca de **US$ 101/mês**, e o NAT passa
a ser o maior item sozinho — motivo pelo qual a camada efêmera existe.

> **O que a estimativa não cobre:** transferência de dados para fora da AWS,
> que depende de uso real e não de configuração. Com o volume de uma barbearia
> de bairro, é desprezível; num marketplace com muitas fotos, não seria.

---

## 7. O que ainda não está provisionado

Vale declarar em vez de deixar a banca descobrir:

| Item | Situação |
|---|---|
| `auth`, `agd` | implementados; prontos para a camada efêmera |
| `bar`, `cat`, `ass`, `ava`, `pag`, `not` | definidos no Terraform, implementação em andamento |
| CloudFront | previsto; depende de certificado, que o Learner Lab não emite |
