# Na Régua

Marketplace de barbearias: o cliente acha a barbearia, escolhe o serviço e o
barbeiro, e marca o horário. A barbearia administra agenda, equipe, planos de
assinatura e o próprio caixa.

Projeto Experimental do curso de Análise e Desenvolvimento de Sistemas —
UniFAAT.

## O problema que o sistema resolve

Barbearia de bairro agenda por WhatsApp. As consequências aparecem rápido:
horário marcado duas vezes para a mesma cadeira, cliente que não aparece e
ninguém registrou, dono sem ideia de quanto cada barbeiro produziu no mês.

O núcleo técnico do projeto é o primeiro desses problemas, porque é o único que
não se resolve com disciplina: **dois clientes tocando "agendar" no mesmo
segundo, para o mesmo barbeiro e o mesmo horário.**

A garantia está no banco, não na aplicação:

```sql
CONSTRAINT cadeira_ocupada_uma_vez EXCLUDE USING gist (
  id_barbeiro WITH =,
  tsrange((dia + comeca_em), (dia + termina_em), '[)') WITH &&
) WHERE (status IN ('agendado', 'concluido'))
```

Entre verificar "está livre" e gravar existe uma janela, e sob concorrência ela
é alcançada. A constraint não tem janela.

## Arquitetura

Oito microsserviços, **um banco lógico e um usuário por serviço**. Nenhum
serviço tem permissão no banco do outro — a separação é imposta pelo Postgres,
não por convenção de código.

| Sigla | Serviço | Responsabilidade |
|---|---|---|
| `auth` | Identidade | conta, sessão, token |
| `bar` | Barbearia | perfil, horário de funcionamento, membros |
| `cat` | Catálogo | serviços, barbeiros, expediente, bloqueios |
| **`agd`** | **Agendamento** | **marcar, cancelar, remarcar — o núcleo** |
| `ass` | Assinatura | planos e ciclo de uso |
| `ava` | Avaliação | nota e comentário do atendimento |
| `pag` | Pagamento | cobrança da plataforma à barbearia |
| `not` | Notificação | avisos por evento, nunca por chamada direta |

Os serviços conversam por evento, com **outbox**: o evento é gravado na mesma
transação da mudança de estado. Sem isso existe o instante em que o dado mudou
e o evento se perdeu, e ninguém fica sabendo.

## Ambiente local

```bash
npm install
npm run db:up        # Postgres, Redis, LocalStack, Prometheus, Grafana
npm run migrar       # cria os oito bancos e aplica as migrations
npm run test:db      # prova as constraints críticas
```

## As regras que o banco recusa

| Estado inválido | Como é impedido |
|---|---|
| Dois atendimentos vivos na mesma cadeira | `EXCLUDE USING gist` com `WHERE status IN (...)` |
| Dois donos na mesma barbearia | índice único **parcial** |
| Bloqueios sobrepostos no mesmo barbeiro | `EXCLUDE USING gist` |
| Duas assinaturas vivas do mesmo cliente na mesma casa | índice único **parcial** |
| Mesmo corte descontado duas vezes do plano | `UNIQUE (id_agendamento)` |
| Duas avaliações do mesmo atendimento | `UNIQUE (id_agendamento)` |
| Webhook de pagamento repetido | `UNIQUE (id_evento_externo)` |

`npm run test:db` prova todas, e também prova o contrário onde importa: outra
cadeira no mesmo horário é aceita, horário encostado é aceito, e cancelar
libera a cadeira.

## Documentação

| | |
|---|---|
| `docs/divisao-do-trabalho.md` | as três frentes e o que cada um defende |

## Migrations

Cada banco tem `schema_migrations`. A migration só roda se ainda não estiver
registrada, e o registro acontece na **mesma transação** da migration. Rodar
duas vezes é seguro.
