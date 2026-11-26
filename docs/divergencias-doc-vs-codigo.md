# Divergências entre os 8 documentos e o código implementado

**Levantado em:** 26/11/2026
**Base:** `main` em `392a7a8`, documento 08 (Planejamento de Sprints), seção
"Cobertura requisito a requisito"
**Para:** T-023 — atualizar os 8 documentos conforme o implementado (Daniel)

---

## Resumo

O documento 08 afirma que **dez requisitos de prioridade Alta não são
atendidos integralmente** pelo escopo comprometido. Essa afirmação está
desatualizada: **nove dos dez já estavam implementados quando este
levantamento foi feito**, o décimo foi fechado em 26/11 pelo T-025, e só o
RF-015 continua de fora.

A divergência é toda na direção favorável — o projeto entrega mais do que o
documento promete. O risco é de avaliação, não de produto: a banca lê
"Adicional" no documento, entende "não foi feito", e desconta por algo que
está no repositório, testado e coberto.

---

## 1. Requisitos marcados como pendentes que estão implementados

| RF | O documento 08 diz | O que o código tem | Evidência |
|---|---|---|---|
| RF-007 | **Parcial** — "catálogo sem busca combinada" | Busca combinando quatro filtros | `services/cat/src/catalogo.js:27-44` — `buscar({ categoria, estadoConservacao, localizacao, texto })`, com o comentário "Busca combinando filtros (RF-007)" e os filtros montados por lista, não por concatenação |
| RF-008 | **Parcial** — "a ficha só exibe após conversão" | A conversão existe, então a condição que tornava o RF parcial caiu | commit `d20fb15` + `services/mid/src/conversao.py` |
| RF-009 | **Adicional** (T-016) | Worker de conversão com FFmpeg | commit `d20fb15 feat(mid): worker de conversao com FFmpeg (T-016)`; `conversao.py` com 91,2% de cobertura |
| RF-010 | **Adicional** (T-016) | idem | idem |
| RF-004b | **Parcial** — "a devolução pelo CAU é adicional" | A devolução pelo CAU existe (T-025, commit `3390278`) | `services/cau/src/caucoes.js` — `liquidar()` com `devolverTodas` |
| RF-023 | **Adicional** (T-025) | Abatimento do arrematante e devolução dos demais, pedida ao provedor e confirmada por webhook | commit `3390278`; 11 testes em `services/cau/tests/liquidacao.test.js` |
| RF-021b | **Adicional** (T-025) | Caução devolvida não volta a ser confirmada | `services/cau/src/caucoes.js:16-25` (estados terminais) + teste `RF-021b: aprovação após devolução NÃO ressuscita a caução` |
| RF-024 | **Adicional** (T-026) | Agendamento de visita | commit `386b33a feat(vis, not): agenda de visita e notificacao`; `services/vis/src/visitas.js` com 97,5% de cobertura e 25 testes |
| RF-025 | **Adicional** (T-026) | idem, com a constraint `EXCLUDE` exercida | idem + `npm run test:db` → "ok 1.2 — outro equipamento no mesmo horário é aceito" |
| RF-026 | **Adicional** (T-026) | idem | idem |
| RF-027 | **Adicional** (T-027) | Notificação ao participante | commit `386b33a`; `services/not/src/notificacoes.js` com 100% de cobertura e 19 testes |
| RF-028 | **Adicional** (T-027) | idem | idem |
| RF-029 | **Adicional** (T-027) | idem | idem |

## 2. O único que continua de fora — e o documento está certo

| RF | Situação real |
|---|---|
| RF-015 — atualização do lance em tempo real | **Não implementado, e corretamente marcado como Adicional.** Não existe WebSocket em nenhum serviço. A interface acompanha por consulta periódica, e isso está escrito no próprio código: `web/src/App.jsx:88` — *"Consulta periódica. Na Sprint do WebSocket (T-012, escopo adicional)"*. |

## 3. RF-023 — estava mesmo incompleto, e foi fechado em 26/11

A ressalva desta seção se confirmou. A investigação achou a ponta solta:

- o LEI publicava `leilao_liquidar` **só no caminho da anulação**. A aprovação
  da reverificação não publicava nada, então `abater_do_arrematante` era
  sempre `null`;
- o CAU **não consumia** o evento. `provedor.devolver()` estava definido e
  nunca era chamado por nenhum código.

Na prática: a caução do arrematante ficava retida para sempre e a dos
perdedores nunca voltava.

Fechado no commit `3390278` (T-025): `aprovarArremate()` no LEI, `liquidar()`
e o consumidor no CAU, mais duas migrations. A devolução é **pedida ao
provedor** e só vira `devolvida` quando o webhook confirma, como o requisito
exige. 17 testes novos.

**RF-023 e RF-004b passam de Adicional/Parcial para Completo.**

## 4. O que muda na tabela da seção "Dez requisitos de prioridade Alta"

O documento 08 fecha com:

> | Parcial | RF-004b, RF-007, RF-008 | 3 |
> | Adicional | RF-009, RF-015, RF-021b, RF-024, RF-025, RF-027, RF-029 | 7 |
> | | | **10** |

Pelo código de hoje, essa tabela vira:

| Situação | Requisitos | Quantos |
|---|---|---:|
| Adicional | RF-015 | 1 |
| | | **1** |

De dez para **um**. É a diferença entre apresentar um MVP e apresentar o
escopo inteiro menos o tempo real.

> Atualizado em 26/11 após o T-025: RF-004b e RF-023 saíram desta tabela
> porque foram implementados. Antes disso eram 2 a 3.

---

## 5. Documentos afetados

| Documento | O que revisar |
|---|---|
| 08 — Planejamento de Sprints | A tabela "Cobertura requisito a requisito" e a tabela dos dez requisitos. T-016, T-026 e T-027 saíram da seção 4.3 (adicional) e devem aparecer como entregues |
| 02 — Requisitos | A situação de RF-007 a RF-010 e RF-024 a RF-029 |
| 05 — Arquitetura em Nuvem e 06 — C4 | Confirmar que `vis`, `not` e `mid` aparecem como serviços implantados, não como previstos |
| 01 — Solicitação do Sistema | Só se o escopo declarado lá excluir visita ou notificação |

---

## Estado da verificação que gerou este documento

Tudo abaixo foi executado em 26/11/2026, com o ambiente local de pé:

| Verificação | Resultado |
|---|---|
| `npm run lint` | sem saída — limpo |
| `npm run test:db` | `TODAS AS CONSTRAINTS CRITICAS PASSARAM` |
| `npm test` (8 serviços + web) | 0 falhas |
| Critério de sucesso do MVP | `✔ (a) 50 lances de VALOR IGUAL: exatamente um aceito` e `✔ (c) sequência sem buraco e sem repetição sob concorrência` |
| `bash db/testes/cobertura.sh` | **GLOBAL 88,5%** — `APROVADO: 88.5% >= 60%` |

A maior lacuna de cobertura é `web/src/App.jsx`, com 163 linhas executáveis em
0,0%. **Não é defeito nem esquecimento:** está decidido e escrito em
`web/src/api.test.js:11-13` — renderizar componente exigiria DOM e
transformação de JSX, ou seja, um segundo executor de testes no projeto, e o
arquivo é contado no denominador da cobertura em vez de ser excluído dela.
Vale defender assim na banca: a lacuna aparece no número em vez de sumir.
