# Planejamento de Sprints e Tarefas

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Metodologia:** Scrum adaptado a equipe pequena
**Duração da Sprint:** 2 semanas
**Responsável por este documento:** José Henrique Teixeira Luiz (3225002)
**Versão:** 1.0 — 27/11/2026

---

## 1. Objetivo

Organizar o desenvolvimento do Na Régua em sprints, com tarefas, responsáveis,
estimativas e critérios de conclusão.

---

## 2. A equipe e as três frentes

O professor pediu que cada integrante tenha trabalho próprio, com commits na
sua frente. A divisão é por **tipo de problema**, não por contagem de serviços
— o `agd` sozinho concentra a concorrência, e os outros sete são
bem-comportados.

| Integrante | Frente | Serviços | Documentos |
|---|---|---|---|
| **José Henrique** (3225002) | Núcleo e infraestrutura | `auth`, `agd` | 05, 07, 08 |
| **Daniel** (6325032) | Dados e catálogo | `bar`, `cat` | 03, 04 |
| **Leandro** (6325072) | Eventos e borda | `ava`, `not`, `pag` + frontend | 01, 02, 06 |

As frentes são independentes: cada uma tem os seus bancos, os seus serviços e o
seu contrato. Ninguém espera o outro para começar.

Cada um responde pela sua frente na arguição. O detalhamento de cada escopo,
com as rotas e as perguntas que cada um precisa saber responder, está em
`docs/divisao-do-trabalho.md`.

### 2.1 Declaração sobre a capacidade

Convém declarar isto agora, em vez de descobrir na defesa: a capacidade de
desenvolvimento do grupo é desigual. Se um integrante não conseguir entregar a
frente dele em código, as saídas são **programação em par com
`Co-Authored-By`** ou **frentes que não são código e que o projeto precisa** —
documentos, roteiro de demonstração, dados de exemplo, teste de carga,
levantamento com barbearias reais.

O que não funciona é nome no documento sem trabalho atrás, nem commit feito por
um com a credencial do outro: a arguição é individual.

---

## 3. Marcos

| Marco | Quando | Evidência |
|---|---|---|
| Documentação técnica (itens 1 a 8) | 4º semestre | PR no repositório da disciplina |
| **MVP funcional** | 4º semestre | o critério da seção 5 |
| Solução completa, deploy, cobertura, monitoramento | 5º semestre | — |
| Defesa perante a banca | 5º semestre | — |

---

## 4. Backlog

### 4.1 Legendas

**Prioridade:** P0 crítico (bloqueia) · P1 alta · P2 média

**Estimativa (SP):** 1 trivial · 2 meio dia · 3 um dia · 5 dois a três dias ·
8 uma semana

As estimativas **já incluem os testes**. Tarefa sem teste não está pronta.

### 4.2 Escopo comprometido

| ID | Épico | Tarefa | Prior. | SP | Resp. | Situação |
|---|---|---|:--:|--:|---|---|
| T-001 | Setup | Monorepo, oito bancos lógicos, lint, padrão de commit | P0 | 3 | José | **Concluída** |
| T-002 | Setup | Docker Compose: Postgres, Redis, LocalStack, Prometheus, Grafana | P0 | 3 | José | **Concluída** |
| T-003 | Dados | Migrations com as constraints críticas do MER | P0 | 5 | José | **Concluída** |
| T-004 | Backend | AUTH: conta, sessão, token, outbox de `conta_criada` | P0 | 5 | José | **Concluída** |
| T-005 | Backend | **AGD: agendamento sob a constraint, com evento** | P0 | 8 | José | **Concluída** |
| T-006 | DevOps | CI: build, lint e teste em PR | P0 | 3 | José | Em andamento |
| T-007 | Backend | BAR: barbearia, horários, membros | P0 | 8 | **Daniel** | A fazer |
| T-008 | Backend | CAT: serviços, barbeiros, expediente, bloqueios | P0 | 8 | **Daniel** | A fazer |
| T-009 | Backend | CAT: publicar `expediente_mudou`; AGD consumir | P1 | 5 | Daniel + José | A fazer |
| T-010 | Backend | NOT: consumir evento e notificar | P1 | 5 | **Leandro** | A fazer |
| T-011 | Backend | AVA: avaliação do atendimento concluído | P1 | 5 | **Leandro** | A fazer |
| T-012 | Backend | PAG: pagamento com webhook idempotente | P1 | 5 | **Leandro** | A fazer |
| T-013 | Backend | ASS: planos, assinatura e consumo do ciclo | P1 | 8 | José | A fazer |
| T-014 | Frontend | Telas do cliente ligadas aos serviços | P1 | 8 | **Leandro** | A fazer |
| T-015 | Frontend | Painel da barbearia ligado aos serviços | P1 | 8 | **Leandro** | A fazer |
| **I-1** | DevOps | Terraform: bootstrap (estado e lock) | P1 | 3 | José | **Concluída** |
| **I-2** | DevOps | Terraform: camada persistente | P1 | 5 | José | **Concluída** |
| **I-3** | DevOps | Terraform: camada efêmera e primeiro serviço no ar | P1 | 8 | José | A fazer |
| **I-4** | DevOps | CI/CD: implantação automatizada | P1 | 5 | José | A fazer |
| **I-5** | DevOps | Prometheus e Grafana no ar | P1 | 5 | José | **Concluída** (local) |
| T-016 | QA | Fechar 60% global e **ligar o bloqueio de merge** | P0 | 5 | José | **Concluída** — 91,0% |
| T-017 | Integração | Google Places: avaliações públicas da barbearia | P1 | 5 | **Leandro** | A fazer |
| T-018 | Todos | Estabilização e correção de defeitos | P1 | 5 | todos | A fazer |
| T-019 | Banca | Roteiro de demonstração e ensaio | P1 | 5 | **Leandro** + José | A fazer |
| T-020 | Docs | Manter os 8 documentos conforme o implementado | P1 | 5 | **Daniel** | Contínua |

### 4.3 Escopo adicional — não é promessa

| ID | Tarefa | SP | Por que ficou de fora |
|---|---|--:|---|
| T-021 | Tempo real na agenda por WebSocket | 5 | A tela recarrega por consulta periódica |
| T-022 | Teste de carga contra os RNF de desempenho | 5 | Exige ambiente estável na AWS |
| T-023 | Fila de espera para horário lotado | 8 | Depende do fluxo de notificação pronto |
| T-024 | Relatório de comissão por barbeiro | 5 | O dado existe; falta a tela |

---

## 5. Critério de sucesso do MVP

O MVP é considerado entregue quando, no ambiente local:

1. Uma pessoa cria conta e autentica;
2. A barbearia cadastra serviço, barbeiro e expediente;
3. **N pedidos de agendamento para o mesmo barbeiro e horário chegam
   simultaneamente, e exatamente um é aceito**, com os demais recusados por
   regra de negócio;
4. Nenhum agendamento confirmado ao cliente está ausente do banco;
5. Cancelar libera a cadeira; concluir não libera.

**O item 3 é verificado por teste automatizado, não por conferência manual.**

### Situação em 27/11/2026

| Item | Situação |
|---|---|
| 1 — conta e autenticação | **Pronto** — `auth` com 12 testes |
| 2 — cadastro de serviço e barbeiro | A fazer — frente do Daniel |
| **3 — concorrência** | **Pronto** — 30 pedidos simultâneos, exatamente um aceito |
| 4 — nada confirmado fora do banco | **Pronto** — verificado no mesmo teste |
| 5 — cancelar libera, concluir não | **Pronto** |

Quatro dos cinco itens estão verificados. O que falta é a frente do Daniel, que
alimenta o item 2 — e que não bloqueia o núcleo, porque o `agd` já funciona
contra o espelho.

---

## 6. Medição em 27/11/2026

| Verificação | Resultado |
|---|---|
| `npm test` | **105 passando, 0 falhas** |
| `npm run test:db` | todas as constraints críticas recusando o que devem |
| Cobertura global | **91,0%** — meta 60%, nenhum arquivo sem teste |
| `terraform validate` | Success, nas duas camadas |
| Prometheus | coletando `auth` e `agd`; os outros seis em `down`, porque ainda não existem |

> A linha do Prometheus é deliberada. Um painel que mostrasse os oito serviços
> verdes hoje estaria mentindo, e durante a montagem deste ambiente um processo
> de outro projeto respondia na porta 3002 e era rotulado como `bar` — um verde
> falso, descoberto justamente porque o serviço não existe.

---

## 7. Definition of Done

Uma tarefa está pronta quando:

1. O código está na `main`, com commit semântico.
2. Tem teste automatizado que **falha se a regra for removida**. Teste que
   passa com a regra desligada não prova nada.
3. `npm run lint` passa sem aviso.
4. A cobertura global continua acima de 60%.
5. A decisão não óbvia está em comentário **no código**, não só no commit.
