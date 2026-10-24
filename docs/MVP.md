# Documento de MVP — Arremate

**NOME DO PROJETO:** Arremate — Plataforma de Leilão de Máquinas e
Equipamentos Industriais

**GRUPO:** José Henrique Teixeira Luiz (3225002), Daniel de Oliveira Tavares
Júnior (6325032), Leandro Duarte (6325072)

---

## 1. OBJETIVO

Desenvolver uma plataforma de leilão online para máquinas e equipamentos
industriais usados, que garanta **ordem e rastreabilidade dos lances** mesmo
quando vários compradores disputam ao mesmo tempo.

## 2. PÚBLICO-ALVO

- **Vendedores:** indústrias e revendas com equipamento parado, que precisam
  desmobilizar e hoje não alcançam comprador fora da própria região.
- **Compradores:** empresas que procuram máquina usada com procedência
  verificável e registro do que foi negociado.

## 3. PROBLEMA QUE RESOLVE

O mercado de máquina industrial usada acontece hoje em grupos de WhatsApp,
classificados genéricos e feiras. As consequências:

- quem vende não alcança comprador fora da região e negocia abaixo do valor;
- quem compra não confirma o estado real da máquina nem se o vendedor existe;
- não fica registro do que foi combinado nem do preço praticado.

## 4. FUNCIONALIDADES DO MVP

Entrega prevista para **07/12/2026**, ao fim do 4º semestre.

| # | Funcionalidade | Requisito |
|---|---|---|
| 1 | Cadastro de empresa com CNPJ, razão social e e-mail | RF-001 |
| 2 | Autenticação com token de sessão | RF-002 |
| 3 | Abertura de leilão com lance inicial, incremento mínimo e prazo | RF-011 |
| 4 | Registro de lance, com rejeição de valor abaixo do mínimo | RF-013 |
| 5 | **Serialização de lances simultâneos, com ordem total garantida** | RF-014 |
| 6 | Interface web mínima: login e tela de lance | — |

**O item 5 é o núcleo do MVP.** Ele demonstra a viabilidade técnica da
proposta: com N lances de mesmo valor chegando ao mesmo tempo, exatamente um
é aceito, e todo lance confirmado fica persistido com número de sequência
único no leilão.

### Já entregue (Sprint 1, 24/10/2026)

- Ambiente reproduzível por Docker Compose
- Sete bancos de dados, um por microsserviço, sem acesso cruzado
- As regras críticas impostas por *constraint* do PostgreSQL, com teste
  automatizado provando que o banco recusa: visita sobreposta, segundo leilão
  ativo no mesmo equipamento e webhook de pagamento repetido

## 5. FUNCIONALIDADES FUTURAS

Previstas para o 5º semestre, detalhadas no documento 08 (Planejamento de
Sprints).

| Funcionalidade | Requisito |
|---|---|
| Habilitação por consulta de CNPJ na BrasilAPI | RF-003 a RF-005 |
| Catálogo de equipamento com ficha técnica e busca | RF-006, RF-007 |
| Upload de fotos e vídeo, com conversão assíncrona | RF-008 a RF-010 |
| Atualização do lance em tempo real por WebSocket | RF-015 |
| Lance automático até um teto definido pelo comprador | RF-016 |
| Prorrogação automática do encerramento | RF-017 |
| Caução: cobrança, webhook e devolução | RF-019 a RF-023 |
| Agendamento de visita técnica | RF-024 a RF-026 |
| Notificação ao participante superado | RF-027 a RF-029 |

## 6. FORA DO ESCOPO

Registrado para evitar expectativa que o projeto não vai atender:

- **Pagamento do valor arrematado.** O sistema trata apenas a **caução** —
  o depósito que libera a participação. A negociação final acontece fora.
- **Logística e frete** do equipamento.
- **Laudo técnico ou vistoria** feita pela plataforma. A visita é agendada
  entre as partes; a plataforma não atesta estado.
- **Emissão de nota fiscal.**

## 7. TECNOLOGIAS

| Camada | Escolha |
|---|---|
| Backend | Node.js com Express — 7 microsserviços |
| Worker de mídia | Python com FFmpeg |
| Frontend | React |
| Banco | PostgreSQL 16, um banco lógico por serviço |
| Cache e tempo real | Redis |
| Mensageria | Amazon SNS + SQS |
| Nuvem | AWS — ECS Fargate, RDS, S3, CloudFront |
| Infraestrutura como código | Terraform |
| CI/CD | GitHub Actions |
| Observabilidade | Prometheus + Grafana |

A justificativa de cada escolha, com as alternativas consideradas e o que se
perdeu em troca, está no documento 07 (Registro de Decisões Arquitetônicas).

## 8. CRITÉRIO DE SUCESSO DO MVP

O MVP é considerado entregue quando, no ambiente local:

1. Uma empresa se cadastra e autentica;
2. Abre um leilão com prazo;
3. **50 requisições de lance de valor igual chegam simultaneamente e
   exatamente uma é aceita**, com as demais rejeitadas por regra de negócio;
4. Nenhum lance confirmado ao cliente está ausente do banco, e a numeração de
   sequência não tem buraco.

O item 3 é verificado por teste automatizado, não por conferência manual.
