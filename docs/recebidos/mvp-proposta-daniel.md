# Leilão online de máquinas industriais usadas

**Documento de visão, casos de uso e MVP**

> **Documento recebido de terceiro, em 24/10/2026.** Está registrado aqui como
> veio, sem alteração de conteúdo — só convertido de texto para Markdown.
>
> **Ele diverge da arquitetura já aprovada e entregue** nos documentos 01 a 08
> (PRs #22 a #28) em pontos que afetam critério obrigatório do termo. A
> comparação está em [`docs/comparacao-mvp.md`](../comparacao-mvp.md). Leia
> antes de desenvolver em cima deste documento.

**Versão:** 1.0 (rascunho) · **Data:** 24/10/2026
**Escopo do MVP:** serviço de lances + regras de banco (visitas e pagamentos)

---

## 1. Visão geral

Plataforma onde vendedores cadastram máquinas industriais usadas e abrem
leilões com prazo. Compradores depositam uma caução e dão lances. Antes de
lançar, o comprador pode agendar uma visita técnica ao equipamento. Os vídeos
enviados pelo vendedor são convertidos em segundo plano.

Arquitetura: 8 microsserviços, cada um com seu próprio banco PostgreSQL.

Ponto crítico: no fim do leilão, muitos compradores dão lance ao mesmo tempo.
O sistema precisa garantir ordem total dos lances, sem perda e sem
duplicidade.

## 2. Atores

| Ator | Papel |
|---|---|
| Vendedor | Cadastra equipamentos e abre leilões |
| Comprador | Deposita caução, agenda visita, dá lances e acompanha |
| Gateway de pagamento | Ator externo. Confirma depósitos de caução via webhook |
| Agendador (timer) | Ator de sistema. Encerra leilões vencidos |

## 3. Microsserviços

> *Marcado no original como:* **suposição — ajustar conforme a divisão real.**

| # | Serviço | Responsabilidade | Banco próprio |
|---|---|---|---|
| 1 | identidade | Cadastro, login, perfis | sim |
| 2 | equipamentos | Catálogo, fotos, metadados | sim |
| 3 | leiloes | Abertura, prazo, encerramento | sim (junto com lances) |
| 4 | lances | Lance concorrente, sequência | sim |
| 5 | pagamentos | Caução, webhooks do gateway | sim |
| 6 | visitas | Agenda de visita técnica | sim |
| 7 | midia | Conversão de vídeo em background | sim |
| 8 | notificacoes | E-mail/push de eventos | sim |

**Regra de convivência:** um serviço nunca lê o banco de outro. Dados de outro
serviço chegam por evento e ficam em **réplica local**. Exemplo: o serviço de
lances mantém a tabela `caucoes_ativas`, alimentada por evento do serviço de
pagamentos.

## 4. Diagrama de casos de uso

```
                  +------------------------------------------------+
                  |        Leilão de máquinas industriais          |
  +----------+    |                                                |
  | Vendedor |----|-- Cadastrar equipamento ---<include>--> Converter vídeo
  |          |----|-- Abrir leilão                                  |
  +----------+    |                                                |
                  |                                                |
  +-----------+   |                                                |
  | Comprador |---|-- Agendar visita técnica                       |
  |           |---|-- Acompanhar leilão                            |
  |           |---|-- Dar lance ----<include>--> Depositar caução   |
  |           |---|-- Depositar caução --<include>--> Confirmar    |
  +-----------+   |                          pagamento (webhook) <--- Gateway
                  |                                                |
  +-----------+   |                                                |
  | Agendador |---|-- Encerrar leilão ---<include>--> Devolver     |
  +-----------+   |   e definir vencedor      caução aos perdedores|
                  +------------------------------------------------+
```

Os diagramas gráficos estão em `docs/casos-de-uso.puml` (PlantUML).

## 5. Especificação dos casos de uso

### UC01 — Cadastrar equipamento

- **Ator:** Vendedor
- **Pré-condição:** Vendedor autenticado
- **Fluxo:**
  1. Informa dados da máquina (tipo, ano, estado, localização)
  2. Envia fotos e vídeo
  3. Sistema salva o equipamento
  4. Sistema enfileira a conversão do vídeo (UC02)
- **Pós-condição:** Equipamento disponível para abrir leilão

### UC02 — Converter vídeo (background)

- **Ator:** Sistema (disparado pelo UC01)
- **Fluxo:**
  1. Worker consome o job de conversão
  2. Gera versões do vídeo para web
  3. Atualiza o equipamento com os links
- **Alternativo:** Falha na conversão — reprocessa com limite de tentativas e
  notifica o vendedor ao esgotar
- **Observação:** Não bloqueia o cadastro nem a abertura do leilão

### UC03 — Abrir leilão com prazo

- **Ator:** Vendedor
- **Pré-condição:** Equipamento cadastrado
- **Fluxo:**
  1. Informa preço inicial, incremento mínimo e data de término
  2. Sistema cria o leilão com status `ABERTO`
- **Exceção:** Já existe leilão `ABERTO` para o mesmo equipamento. O banco
  recusa (regra RB01) e o sistema informa o vendedor

### UC04 — Depositar caução

- **Ator:** Comprador (confirmação pelo Gateway)
- **Fluxo:**
  1. Comprador solicita depósito para um leilão
  2. Gateway processa o pagamento
  3. Gateway envia webhook de confirmação (UC05)
  4. Caução fica ativa e o evento chega ao serviço de lances
- **Pós-condição:** Comprador habilitado a dar lance naquele leilão

### UC05 — Confirmar pagamento (webhook)

- **Ator:** Gateway de pagamento
- **Fluxo:**
  1. Recebe o evento e grava em `webhook_eventos`
  2. Ativa a caução correspondente
- **Exceção:** Evento repetido. O banco recusa (regra RB03); o sistema responde
  sucesso ao gateway sem reprocessar

### UC06 — Agendar visita técnica

- **Ator:** Comprador
- **Fluxo:**
  1. Escolhe equipamento e período
  2. Sistema registra a visita
- **Exceção:** Período se sobrepõe a outra visita do mesmo equipamento. O banco
  recusa (regra RB02) e o sistema sugere outro horário
- **Observação:** Visita cancelada libera o horário

### UC07 — Dar lance *(caso crítico)*

- **Ator:** Comprador
- **Pré-condição:** Leilão `ABERTO` e caução ativa do comprador
- **Fluxo principal:**
  1. Comprador envia o valor do lance
  2. Sistema abre transação e trava a linha do leilão
     (`SELECT ... FOR UPDATE`). Lances simultâneos esperam em fila
  3. Dentro da trava, revalida todas as regras (seção 6)
  4. Calcula `seq = seq_atual + 1`
  5. Grava o lance com `seq` e atualiza `lance_atual`, `lider_id` e `seq_atual`
     do leilão
  6. Confirma a transação e libera a trava
- **Fluxos alternativos** (lance recusado, sem gravar nada):
  - A. `leilao_inexistente`
  - B. `leilao_encerrado` (status diferente de `ABERTO` ou prazo vencido)
  - C. `vendedor_nao_pode_dar_lance`
  - D. `sem_caucao`
  - E. `lance_abaixo_do_minimo`
- **Pós-condição:** Sequência dos lances do leilão contígua e valores
  crescentes

### UC08 — Acompanhar leilão

- **Ator:** Comprador
- **Fluxo:** Consulta lance atual, líder, prazo restante e histórico

### UC09 — Encerrar leilão e definir vencedor

- **Ator:** Agendador (timer)
- **Fluxo:**
  1. Localiza leilões `ABERTO` com prazo vencido
  2. Trava o leilão, muda o status para `ENCERRADO`
  3. Define o vencedor (maior lance, último `seq`) e dispara UC10

### UC10 — Devolver caução aos perdedores

- **Ator:** Sistema
- **Fluxo:** Solicita ao serviço de pagamentos a devolução das cauções dos
  compradores que não venceram

## 6. Regras de negócio do lance

| ID | Regra |
|---|---|
| RN01 | O lance só vale se o leilão estiver `ABERTO` e dentro do prazo |
| RN02 | O vendedor não pode dar lance no próprio leilão |
| RN03 | O comprador precisa de caução ativa naquele leilão |
| RN04 | Primeiro lance: valor ≥ preço inicial |
| RN05 | Demais lances: valor ≥ lance atual + incremento mínimo |
| RN06 | Cada lance recebe um número de sequência por leilão: 1, 2, 3… |

Todas são revalidadas **dentro da trava**. O que foi lido antes de travar não
vale.

> **Detalhe importante:** o prazo é comparado com `clock_timestamp()`, não com
> `now()`. O `now()` congela no início da transação; quem esperou na fila da
> trava seria avaliado com horário antigo e poderia lançar depois do fim.

## 7. Regras garantidas pelo banco (constraints)

Estas três regras não dependem do código. Se a aplicação errar, o banco recusa.

### RB01 — Leilão duplicado

Índice único parcial em `leiloes(equipamento_id) WHERE status = 'ABERTO'`.
Um equipamento só pode ter um leilão aberto. Depois de encerrado, um novo
leilão é permitido.

### RB02 — Visita sobreposta

```sql
EXCLUDE USING gist (equipamento_id WITH =, periodo WITH &&)
WHERE (status <> 'CANCELADA')
```

Períodos que se cruzam no mesmo equipamento são recusados. Visitas encostadas
(fim de uma = início da outra) ou em outro equipamento passam.

### RB03 — Webhook repetido

`UNIQUE (provedor, evento_id)` em `webhook_eventos`. O gateway pode reenviar o
mesmo evento; o banco impede o segundo.

**Reforço no lance:** `UNIQUE (leilao_id, seq)` em `lances` impede sequência
repetida.

## 8. MVP entregue

```
leilao-mvp/
  docker-compose.yml            Postgres 16
  requirements.txt
  README.md
  db/schema.sql                 Tabelas e as 3 constraints
  app/lances.py                 dar_lance(): trava, revalida, grava com seq
  app/api.py                    POST /leiloes/{id}/lances
                                POST /webhooks/pagamento/{provedor}
  tests/conftest.py             Fixtures (limpa tabelas, cria leilão e cauções)
  tests/test_lances_concorrentes.py
  tests/test_constraints.py
  docs/casos-de-uso.puml        Diagramas (geral e do lance)
  docs/documento-leilao.txt     Este documento
```

**Testes:**

`test_lances_concorrentes`
- 40 compradores disparam juntos (barreira de threads)
- Confere: sequência sem buraco e sem repetição; valores estritamente
  crescentes respeitando o incremento; estado do leilão igual ao último lance
  gravado; aceitos + recusados = 40; o maior lance está entre os aceitos
- Lance após o prazo é recusado

`test_constraints`
- `INSERT` em SQL puro, sem passar pelo código da aplicação
- Leilão duplicado, visita sobreposta e webhook repetido são recusados
- Casos permitidos também testados (leilão novo após encerrar, visitas
  adjacentes, horário liberado após cancelamento)

**Como rodar:**

```bash
docker compose up -d
pip install -r requirements.txt
pytest -v
uvicorn app.api:app --reload
```

> **STATUS (do original):** os testes foram escritos mas **não foram
> executados** no ambiente em que o MVP foi gerado (sem Postgres disponível).
> Executar localmente antes de usar.

## 9. Fora do MVP / próximos passos

- Serviços de identidade, equipamentos, mídia e notificações
- Entrega confiável de eventos entre serviços (ex.: caução confirmada virando
  evento para o serviço de lances sem perder nem duplicar mensagem)
- Pool de conexões na API (o MVP abre uma conexão por requisição)
- Autenticação e autorização
- Encerramento automático (UC09) e devolução de caução (UC10)
- Teste de carga com mais compradores e vários leilões em paralelo
- Tela de acompanhamento em tempo real

## 10. Suposições assumidas

- A divisão dos 8 microsserviços (seção 3) é uma proposta
- Visita sobreposta é avaliada por equipamento
- A caução é por leilão (um depósito habilita um leilão)
- Incremento mínimo e preço inicial são definidos pelo vendedor
