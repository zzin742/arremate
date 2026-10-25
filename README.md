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
services/              os 8 microsserviços
  auth hab cat mid lei cau vis not
packages/shared/       biblioteca comum: conexão, outbox, métricas,
                       prefixo do ALB, contratos de evento
web/                   frontend React + Vite
db/
  init/                bancos lógicos e usuários do compose, um por serviço
  migrations/          por banco; _comum/ é aplicado em todos
  migrar.js            cria os bancos e aplica as migrations — o caminho
                       que serve ao compose E ao RDS
  testes/              prova das constraints e mede a cobertura
infra/
  bootstrap/           bucket de state e trava
  ambientes/dev/       persistente (sobrevive) e efêmera (sobe e desce)
  observabilidade/     Prometheus e painel do Grafana
  localstack-init/     tópicos e filas do ambiente local
testes/servidor.js     sobe o app numa porta livre, para os testes HTTP
scripts/               credenciais do lab para os secrets do CI
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

São **oito bancos**, um por serviço. O usuário `arremate` é o dono e enxerga
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

## Rodar tudo (MVP de dezembro)

```bash
npm run db:up                                  # Postgres, Redis, LocalStack
npm run test:db                                # migrations + constraints
npm start -w @arremate/auth   &                # :3001
npm start -w @arremate/lei    &                # :3002
npm run web                                    # :5173
```

Abra http://localhost:5173, cadastre uma empresa, abra um leilão e dê
lances. Para ver a disputa, abra duas abas com empresas diferentes — o
vendedor não consegue lançar no próprio leilão.

CNPJs válidos para teste: `11222333000181` e `11444777000161`.

## Implantação na AWS

A infraestrutura é Terraform em três camadas, e a divisão não é
organizacional — é de custo e de risco:

| Camada | O que tem | Quando some |
|---|---|---|
| `bootstrap` | bucket do state e trava | nunca |
| `persistente` | ECR, S3, SNS, SQS, snapshots | nunca (`prevent_destroy`) |
| `efêmera` | VPC, RDS, Redis, ALB, Fargate | **sobe e desce a cada sessão** |

A efêmera é quem gasta o crédito do Learner Lab. O encerramento tem três
passos, nesta ordem: zerar as tarefas (`sessao_ativa=false`), tirar o
snapshot do banco, destruir. A retomada restaura do snapshot pela variável
`snapshot_sessao`.

> As três variáveis — `bucket_state`, `usar_cloudfront` e `imagem_tag` —
> vão em **todo** `apply`. O `-var` não se herda entre execuções: omitir
> uma faz o Terraform voltar ao padrão dela, e `usar_cloudfront` voltando
> a `true` tenta criar uma distribuição que a conta do lab não permite.

O deploy (`.github/workflows/deploy.yml`) dispara depois do CI passar,
constrói as imagens com o SHA do commit como tag, aplica o Terraform,
roda as migrations como tarefa avulsa e **confere `/api/<servico>/saude`
pelo ALB**. Esse último passo existe porque o ECS dá o serviço por estável
comparando contagem de tarefas: ele fica verde com o serviço no ar
devolvendo 404 em toda rota, que foi exatamente o que aconteceu na
primeira subida.

Sem sessão de lab aberta, o deploy pula com um aviso em vez de falhar —
credencial do AWS Academy dura uma tarde, e não ter uma é o estado normal
do repositório. Para implantar: abra o lab e rode
`bash scripts/credenciais-ci.sh`.

## Observabilidade

```bash
docker compose up -d prometheus grafana
```

| Onde | Endereço |
|---|---|
| Grafana (painel já provisionado, sem login) | http://localhost:3030 |
| Prometheus | http://localhost:9090 |
| Métricas de um serviço | `http://localhost:3001/metricas` |

O painel **Arremate — requisitos não funcionais** desenha, em cada gráfico,
o limite do requisito que ele mede: 300 ms do RNF-001, 500 ms do RNF-002,
300 s do RNF-007b. São os números dos requisitos, não valores escolhidos
para o gráfico ficar bonito.

Os serviços rodam no host, não em contêiner, e o Prometheus os alcança por
`host.docker.internal`. Serviço desligado aparece como `up = 0` — é assim
que o RNF-006 é medido, e é justamente quando ele está fora que ele não
consegue exportar nada sobre si.

Dois detalhes que valem saber antes de mexer na configuração:

- O rótulo de rota é o **padrão** (`/leiloes/:id/lances`), nunca a URL.
  Uma série por leilão derrubaria o Prometheus antes de medir qualquer
  coisa.
- O rótulo `servico` é posto pela configuração de raspagem, não pela
  aplicação. Pondo nos dois, o Prometheus renomeia o da aplicação para
  `exported_servico`.

## Testes

```bash
npm test          # 227 testes dos serviços (precisa do banco de pé)
npm run lint
bash db/testes/cobertura.sh   # cobertura global pela regra do RNF-020
```

Os testes são de **integração**: batem num Postgres de verdade, com as
constraints aplicadas. Rodar sem banco não provaria nada sobre as regras,
que é justamente onde elas moram.

Por isso os arquivos de teste de um serviço rodam em série
(`--test-concurrency=1`): compartilham um banco e o `TRUNCATE` do
`beforeEach` de um zeraria a mesa do outro.

A cobertura é medida pela regra do RNF-020 — **soma das linhas cobertas ÷
soma das linhas executáveis**, não média de porcentagens, com os arquivos
sem teste nenhum dentro do denominador. Abaixo de 60% o script sai com
erro e reprova o job, que é o que o RNF-023 pede: gerar relatório não
implementa bloqueio.
