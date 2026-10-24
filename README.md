# Arremate

Plataforma de leilão online de máquinas e equipamentos industriais usados.
Projeto Experimental — ADS / UniFAAT.

A documentação técnica (8 documentos) vive no fork do repositório do
professor: [`zzin742/UniFAAT-projeto-experimental-2027-1`](https://github.com/zzin742/UniFAAT-projeto-experimental-2027-1),
pasta `Arremate/`. Este repositório é o **código**.

## Integrantes

| Nome | RA | Papel |
|---|---|---|
| José Henrique Teixeira Luiz | 3225002 | Desenvolvimento integral |
| Daniel de Oliveira Tavares Júnior | 6325032 | Documentação e diagramas |
| Leandro Duarte | 6325072 | Estudo e apresentação |

## Subir o ambiente local

Precisa de Docker e Node 20+.

```bash
npm run db:up        # Postgres, Redis e LocalStack (S3, SNS, SQS)
npm run test:db      # aplica migrations e prova as constraints
```

Para começar do zero: `npm run db:reset`.

## Estrutura

```
services/          os 8 microsserviços
  auth hab cat mid lei cau vis not
packages/shared/   biblioteca comum (outbox, contratos de evento)
db/
  init/            criação dos bancos lógicos e usuários, um por serviço
  migrations/      por banco; _comum/ é aplicado em todos
  testes/          prova das constraints críticas
infra/             Terraform em três camadas + init do LocalStack
```

## O banco impõe as regras, não o código

Três regras críticas são **constraints**, não validação de aplicação. Se o
código errar, o banco ainda recusa:

| Regra | Como | Requisito |
|---|---|---|
| Duas visitas sobrepostas no mesmo equipamento | `EXCLUDE USING gist` com `WHERE status = 'agendada'` | RF-025 |
| Dois leilões ativos para o mesmo equipamento | índice único **parcial** | RF-011 |
| Webhook de pagamento repetido | `UNIQUE (id_evento_externo)` | RF-021 |
| Lance fora de ordem no leilão | `UNIQUE (id_leilao, sequencia)` | RF-014 |
| Arremate apontando para lance de outro leilão | FK **composta** | — |

`npm run test:db` prova as cinco. O CI vai além: derruba uma constraint de
propósito e **exige que o teste acuse** — teste que não falha quando a regra
some não prova nada.

## Migrations

Cada banco tem `schema_migrations`. A migration só roda se ainda não estiver
registrada, e o registro acontece na **mesma transação** da migration. Rodar
duas vezes é seguro.

## Conectar pelo DBeaver

Com `npm run db:up` rodando:

| Campo | Valor |
|---|---|
| Host | `localhost` |
| Porta | `5432` |
| Usuário | `arremate` |
| Senha | `arremate` |
| Banco | `arremate_auth`, `arremate_lei`, `arremate_cau`, `arremate_vis`… |

São **sete bancos**, um por serviço. O usuário `arremate` é o dono e enxerga
todos; os usuários `svc_auth`, `svc_lei` etc. enxergam só o próprio — é assim
que a separação é imposta, e não por convenção.

Pra ver as constraints no DBeaver: *Database Navigator* → banco → `Schemas`
→ `public` → `Tables` → tabela → aba **Constraints**.

## Rodar o AUTH

```bash
npm run db:up
npm run test:db                                   # migrations + constraints
PGDATABASE=arremate_auth npm test -w @arremate/auth   # testes do serviço
PGDATABASE=arremate_auth npm start -w @arremate/auth  # sobe em :3001
```

Endpoints: `POST /empresas`, `POST /sessoes`, `GET /eu`, `GET /saude`.
