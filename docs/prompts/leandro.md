Você vai implementar a minha frente de um Projeto Experimental da faculdade (ADS, UniFAAT). O projeto é o **Na Régua**, um marketplace de barbearias: o cliente acha a barbearia, escolhe o serviço e o barbeiro, e marca o horário.

Meu nome é Leandro. Minha frente é **"Eventos e borda"** — os serviços `not`, `ava` e `pag`, mais a ligação das telas com os serviços.

## Antes de escrever qualquer código

Clone o repositório e leia, nesta ordem:

1. `README.md` — o problema e a arquitetura
2. `docs/divisao-do-trabalho.md` — a minha frente está detalhada lá
3. `docs/entregaveis/07-registro-decisoes-arquitetonicas-adr.md` — **leia inteiro**, principalmente a ADR-004 (comunicação por evento, com outbox). Ela é a base de tudo o que eu vou fazer.
4. `db/migrations/not/`, `db/migrations/ava/` e `db/migrations/pag/` — o meu schema já existe
5. `services/agd/src/agendamentos.js` — é a referência de estilo, e é quem publica os eventos que eu vou consumir
6. `packages/shared/src/consumidor.js` — o utilitário de consumo de fila que eu vou usar

Suba o ambiente antes de começar:

```bash
npm install
npm run db:up
npm run migrar
npm test          # tem de passar antes de eu mexer em nada
```

## O que eu tenho de entregar

### `services/not` — notificação

**Este serviço nunca é chamado por HTTP por outro serviço.** Ele só consome evento. É isso que garante que notificação jamais bloqueie um agendamento — se o provedor de e-mail estiver fora do ar, o corte continua marcado.

Eventos a consumir, todos publicados pelo `agd`:

| Evento | O que notificar |
|---|---|
| `agendamento_criado` | confirma para o cliente, avisa a barbearia |
| `agendamento_cancelado` | avisa o outro lado |
| `atendimento_concluido` | convida o cliente a avaliar |

A regra difícil: **a entrega do evento é "ao menos uma vez"**. O mesmo evento chega duas vezes, e o cliente não pode receber o mesmo lembrete duas vezes. A tabela `notificacao` tem `UNIQUE (id_evento)` justamente para isso — a segunda tentativa de gravar falha com `unique_violation` (código `23505`), e eu trato isso como "já notifiquei" em vez de erro.

O envio em si pode ser um adaptador falso por enquanto (gravar o estado `enviado` e registrar), desde que a interface permita trocar por um provedor real depois.

### `services/ava` — avaliação

```
POST   /avaliacoes                    avalia um atendimento
GET    /barbearias/:id/avaliacoes     avaliações públicas
```

Regras:

- **uma avaliação por atendimento** — `UNIQUE (id_agendamento)`. Sem isso o cliente avalia de novo e empurra a média da barbearia para onde quiser.
- **só quem foi atendido avalia.** O `ava` consome `atendimento_concluido` e guarda em `atendimento_espelho`. Avaliação de atendimento que não está no espelho é recusada — e a pessoa que avalia tem de ser a mesma do atendimento.
- nota de 1 a 5, já imposta por `CHECK` no banco.

### `services/pag` — pagamento da plataforma

```
POST   /pagamentos                    registra pagamento manual
POST   /webhooks/:provedor            webhook do provedor
GET    /barbearias/:id/pagamentos     histórico
```

A regra: **webhook repetido não lança o pagamento duas vezes.** `UNIQUE (id_evento_externo)`. O provedor reenvia enquanto não receber 2xx, então evento repetido tem de responder **sucesso** — insistir num evento já processado só geraria mais chamadas.

Atenção ao que o sistema cobra: a plataforma cobra **da barbearia**, não do cliente final. O que o cliente paga pelo corte acontece no balcão e está fora do sistema.

### Integração com o Google Places

É a **API externa exigida pelo termo de aceite**, então ela não é opcional. A barbearia tem o campo `id_google_place`, e eu preciso puxar as avaliações públicas do Google para mostrar junto com as nossas.

O projeto antigo já fazia isso — olhe `apps/cliente/src/app/api/google-reviews/route.ts` e `apps/painel/src/app/api/google-place/route.ts` no repositório antigo do Na Régua, se eu tiver acesso.

### As telas

O design e as imagens já existem no projeto antigo do Na Régua (`apps/cliente` e `apps/painel`). **Reaproveite o visual**; o que muda é de onde vêm os dados: antes era Supabase, agora são os nossos serviços por HTTP.

## Como eu quero que você trabalhe

- **Teste primeiro, ou junto.** Todo teste tem de falhar se a regra for removida. O caso mais importante da minha frente é sempre o mesmo: **entregar o evento duas vezes e provar que o efeito acontece uma vez só.** Olhe `services/agd/tests/agendamentos.test.js` para o padrão.
- **Comentário explica o porquê, não o quê.**
- **Não mexa em `services/auth`, `services/agd`, `services/bar`, `services/cat`, `infra/` nem nas migrations dos outros.** São de outras frentes.
- **Em português**, igual ao resto do projeto.
- Rode `npm run lint` e `npm test` antes de cada commit. A cobertura global não pode cair abaixo de 60%.

## O que eu preciso saber defender na banca

A arguição é individual, então me ajude a entender, não só a ter o código pronto. Quando terminar, me explique com as suas palavras:

1. Por que notificação é por evento e não por chamada direta do `agd`? O que aconteceria se fosse HTTP?
2. A entrega do evento é "ao menos uma vez". Como o cliente não recebe o mesmo lembrete duas vezes?
3. Por que o evento é gravado na tabela `outbox` dentro da transação, em vez de ser publicado logo depois do COMMIT?

Comece lendo os arquivos que listei e me diga o que entendeu do projeto antes de escrever a primeira linha.
