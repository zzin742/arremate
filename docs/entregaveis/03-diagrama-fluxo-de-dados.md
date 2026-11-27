# Diagrama de Fluxo de Dados

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Versão:** 1.0 — 27/11/2026

---

## 1. Objetivo

Mapear como a informação atravessa as fronteiras do Na Régua: o que entra, de
onde vem, por onde passa e onde fica armazenado.

A fronteira que mais importa aqui é a **entre serviços**. Como nenhum serviço
lê o banco de outro (ADR-003), todo dado que atravessa essa linha passa por uma
rota HTTP ou por um evento — e o diagrama mostra qual dos dois, e por quê.

---

## 2. Entidades externas

| Entidade | O que envia | O que recebe |
|---|---|---|
| **Cliente** | cadastro, pedido de agendamento, cancelamento, avaliação | horários livres, confirmação, lembrete |
| **Barbearia** | cadastro, serviços, barbeiros, expediente, bloqueios, encaixe | agenda do dia, aviso de marcação e cancelamento |
| **Google Places** | — | avaliações públicas da barbearia |
| **Provedor de pagamento** | webhook de pagamento confirmado | pedido de cobrança |

---

## 3. Nível 0 — contexto

```
   Cliente ──── cadastro, agendamento, avaliação ────┐
                                                      ▼
   Barbearia ── serviços, expediente, encaixe ──▶ ┌─────────────┐
                                                   │  Na Régua   │
   Google Places ── avaliações públicas ─────────▶ │             │
                                                   └──────┬──────┘
   Provedor de pagamento ◀── cobrança ──────────────────┤
                         ──── webhook ────────────────▶ │
                                                         ▼
                                      confirmação, lembrete, agenda do dia
```

---

## 4. Nível 1 — o caminho de um agendamento

É o fluxo central do sistema, e o que mais atravessa fronteiras.

```
┌─────────┐
│ Cliente │
└────┬────┘
     │ 1. GET /barbeiros/:id/livres          (sem sessão)
     ▼
┌──────────────────────────────────────────────────────┐
│ AGD                                                   │
│   lê: expediente_espelho, bloqueio_espelho,           │
│       agendamento                                     │
│   devolve: lista de horários                          │
└──────────────────────────────────────────────────────┘
     │
     │ 2. POST /agendamentos  (com token do AUTH)
     ▼
┌──────────────────────────────────────────────────────┐
│ AGD — dentro de UMA transação                         │
│                                                       │
│   a) o horário já passou?    clock_timestamp()        │
│   b) o barbeiro trabalha?    expediente_espelho       │
│   c) há bloqueio?            bloqueio_espelho         │
│   d) INSERT em agendamento   ◀── a constraint decide  │
│   e) INSERT em outbox        ── mesma transação       │
│                                                       │
└───────────────────────┬──────────────────────────────┘
                        │ COMMIT
                        ▼
                ┌───────────────┐
                │    outbox     │
                └───────┬───────┘
                        │ publicador
                        ▼
                ┌───────────────┐
                │  SNS: tópico  │  agendamento-criado
                └───────┬───────┘
          ┌─────────────┴─────────────┐
          ▼                           ▼
   ┌─────────────┐            ┌──────────────┐
   │ SQS         │            │ SQS          │
   │ notificacao │            │ (outras)     │
   └──────┬──────┘            └──────────────┘
          ▼
   ┌─────────────┐
   │ NOT         │  grava notificacao (UNIQUE id_evento)
   │             │  e avisa cliente e barbearia
   └─────────────┘
```

### O que decide HTTP ou evento

| Caso | Mecanismo | Por quê |
|---|---|---|
| Cliente pede horários livres | HTTP | Resposta síncrona: ele está esperando na tela |
| Cliente marca | HTTP | Idem, e precisa saber se conseguiu |
| AGD avisa que marcou | **Evento** | Quem recebe não pode atrasar nem derrubar o agendamento |
| AGD lê o expediente | **Espelho local** | A leitura acontece **dentro da transação**; HTTP ali seguraria a transação pela rede (ADR-005) |

---

## 5. Nível 1 — o expediente e o espelho

```
┌───────────┐
│ Barbearia │
└─────┬─────┘
      │ PUT /barbeiros/:id/expediente
      ▼
┌──────────────────────────────────────────┐
│ CAT — dentro de UMA transação             │
│   a) UPDATE expediente                    │
│   b) INSERT outbox 'expediente_mudou'     │
└──────────────────┬───────────────────────┘
                   │ COMMIT
                   ▼
            SNS ──▶ SQS ──▶ ┌────────────────────────┐
                            │ AGD                     │
                            │  UPSERT em              │
                            │  expediente_espelho     │
                            └────────────────────────┘
```

**A cópia não é fonte de verdade.** A verdade é o `cat`; o `agd` tem uma cópia
para poder decidir sem sair pela rede. O preço é consistência eventual: mudar
o expediente leva alguns segundos para valer.

---

## 6. Nível 1 — a conclusão do atendimento

Um evento, três consumidores, cada um com a sua idempotência.

```
┌──────────────┐
│ AGD          │ POST /agendamentos/:id/concluir
│  UPDATE +    │
│  outbox      │
└──────┬───────┘
       ▼
  SNS: atendimento-concluido
       │
   ┌───┼────────────────┬──────────────────┐
   ▼                    ▼                  ▼
┌──────┐          ┌──────────┐       ┌──────────┐
│ NOT  │          │   ASS    │       │   AVA    │
│      │          │          │       │          │
│ avisa│          │ desconta │       │ libera a │
│ e    │          │ do plano │       │ avaliação│
│ convi│          │          │       │          │
│ da a │          │ UNIQUE   │       │ UNIQUE   │
│ avali│          │ (id_agen)│       │ (id_agen)│
│ ar   │          │          │       │          │
└──────┘          └──────────┘       └──────────┘
```

A entrega é **ao menos uma vez**. Cada consumidor recebe o mesmo evento mais de
uma vez, e a chave única no banco de cada um é o que impede o efeito duplicado:
descontar duas vezes do plano cobraria o cliente por um corte que ele fez uma
vez.

---

## 7. Armazenamento

| Depósito | Serviço dono | O que guarda |
|---|---|---|
| `naregua_auth` | AUTH | conta, hash da senha, bloqueio |
| `naregua_bar` | BAR | barbearia, horário, fechamento, membro |
| `naregua_cat` | CAT | serviço, barbeiro, expediente, bloqueio |
| `naregua_agd` | AGD | agendamento + espelhos de expediente e bloqueio |
| `naregua_ass` | ASS | plano, assinatura, uso |
| `naregua_ava` | AVA | avaliação + espelho de atendimento concluído |
| `naregua_pag` | PAG | pagamento da plataforma |
| `naregua_not` | NOT | notificação enviada |
| S3 | — | fotos de barbearia, barbeiro e serviço |
| Redis | — | cache de leitura |

Cada banco é acessível **apenas** pelo usuário do serviço dono.

---

## 8. Dados sensíveis nas fronteiras

| Dado | Onde vive | Atravessa fronteira? |
|---|---|---|
| Senha em claro | em lugar nenhum | nunca |
| Hash da senha | `naregua_auth` | **não** — não entra em payload de evento nem em resposta |
| Token de sessão | navegador | HTTP, cabeçalho `Authorization` |
| WhatsApp do cliente | `naregua_auth`, `naregua_agd` (encaixe) | sim, para a barbearia poder avisar |
| Motivo de bloqueio | `naregua_auth` | **não chega ao bloqueado** |

A regra geral: **o que entra num evento passa a existir fora do banco que o
originou**, porque percorre SNS e SQS e fica retido na fila. Por isso o payload
de `conta_criada` leva id, nome e e-mail, e não leva credencial.
