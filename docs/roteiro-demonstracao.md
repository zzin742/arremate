# Roteiro de demonstração — Arremate (T-024)

**Grupo:** José Henrique Teixeira Luiz (3225002), Daniel de Oliveira Tavares
Júnior (6325032), Leandro Duarte (6325072)
**Duração alvo:** 12 minutos de demonstração + arguição

---

## Antes de entrar na sala

Faça isto **15 minutos antes**, não na hora:

```bash
cd arremate
bash scripts/demo.sh --semear
```

O script sobe Postgres, roda as migrations, sobe AUTH e LEI, sobe a interface,
**espera cada peça responder** antes da seguinte, e cria uma empresa de
demonstração. Ele imprime o e-mail e a senha gerados — anote os dois.

Se qualquer passo falhar, o script diz qual e aponta o log em `.demo-logs/`.
Ctrl+C derruba tudo o que ele subiu.

**Checagem de 30 segundos:**

| O quê | Esperado |
|---|---|
| `curl -s localhost:3001/saude` | `{"servico":"auth","ok":true}` |
| `curl -s localhost:3002/saude` | `{"servico":"lei","ok":true}` |
| `http://localhost:5173` no navegador | tela de login do Arremate |
| Docker Desktop | cinco contêineres verdes |

Deixe **três abas** abertas e nada mais: a interface, um terminal e o Grafana
em `http://localhost:3030`.

---

## Bloco 1 — O problema (1 min) · DANIEL

> "Máquina industrial usada é vendida hoje em grupo de WhatsApp e feira. Quem
> vende não alcança comprador fora da região e negocia abaixo do valor; quem
> compra não confirma o estado real nem se o vendedor existe; e não fica
> registro do que foi combinado."

> "O Arremate é um leilão online para esse mercado. O núcleo técnico do MVP é
> um só: **com vários compradores disputando ao mesmo tempo, a ordem dos
> lances tem que ser total e rastreável.** É isso que a gente veio provar."

Não abra tela ainda. Este bloco é falado.

---

## Bloco 2 — A arquitetura (2 min) · DANIEL

Desenhe ou projete:

```
         ┌── AUTH ──┐  ┌── HAB ──┐  ┌── CAT ──┐  ┌── MID ──┐
Browser ─┤          │  │         │  │         │  │ FFmpeg  │
         └── LEI ───┘  └── CAU ──┘  └── VIS ──┘  └── NOT ──┘
              │             │
         Postgres      Postgres        SNS → SQS entre eles
         (um banco por serviço, sem acesso cruzado)
```

Três frases, uma por ideia:

> "São oito serviços, cada um com **seu próprio banco**. Nenhum lê a tabela do
> outro — a separação é imposta por usuário do Postgres, não por combinação
> entre nós."

> "Os serviços conversam por evento, com **outbox**: o evento é gravado na
> mesma transação da mudança de estado. Sem isso existe o instante em que o
> dado mudou e o evento se perdeu, e ninguém nunca fica sabendo."

> "As regras críticas estão **no banco**, como constraint, não só no código.
> Se a aplicação tiver bug, o banco ainda recusa."

---

## Bloco 3 — A demonstração (6 min) · JOSÉ

### 3.1 — A tela (1 min)

Interface em `localhost:5173`. Entre com a empresa semeada, abra um leilão
("Torno mecânico 1998", lance inicial 1000, incremento 100) e mostre a tela do
leilão com lance atual e contagem.

> "É a interface mínima do MVP: login e tela de lance. Deliberadamente mínima —
> o que a gente foi defender está embaixo."

### 3.2 — As constraints (1 min) · terminal

```bash
npm run test:db
```

> "Cinco regras que o banco recusa, não o código: visita sobreposta, segundo
> leilão ativo no mesmo equipamento, webhook de pagamento repetido, lance fora
> de ordem e arremate apontando para lance de outro leilão."

Aponte a última linha: `TODAS AS CONSTRAINTS CRITICAS PASSARAM`.

### 3.3 — O núcleo: concorrência (2 min) · terminal

**Este é o momento da apresentação.** Não corra.

```bash
npm test --workspace @arremate/lei
```

Aponte na tela:

```
▶ RF-014 — concorrência
  ✔ (a) 50 lances de VALOR IGUAL: exatamente um aceito
  ✔ (c) sequência sem buraco e sem repetição sob concorrência
```

> "Cinquenta requisições de lance com o mesmo valor, disparadas ao mesmo
> tempo. Exatamente uma é aceita. E a numeração de sequência não tem buraco
> nem repetição."

> "O que garante isso é um `SELECT ... FOR UPDATE` na linha do leilão: quem
> chega segundo **espera**, e quando entra relê o estado. Não é otimista, não
> é retry — é fila."

> "O critério de sucesso do MVP é exatamente este teste. Está escrito no
> documento de MVP, e é verificado por automação, não por conferência manual."

### 3.4 — O ciclo do dinheiro (1,5 min) · terminal

```bash
npm test --workspace @arremate/cau
```

> "O leilão encerra, o LEI decide quem é o arrematante e publica. O CAU abate a
> caução dele e **pede a devolução das outras ao provedor**."

> "A sutileza está aqui: a caução só vira `devolvida` quando o webhook do
> provedor confirma. Até lá ela fica `confirmada` com a marca de que o pedido
> foi feito. Carimbar `devolvida` no banco seria dizer que devolveu sem ter
> devolvido."

Aponte: `✔ a devolução é PEDIDA ao provedor, não carimbada no banco`.

### 3.5 — Observabilidade (0,5 min)

Abra `http://localhost:3030`. Mostre o painel já provisionado.

> "Prometheus e Grafana sobem junto, com o painel provisionado — não é
> configuração feita na mão que se perde."

---

## Bloco 4 — Qualidade e processo (2 min) · MATHEUS/LEANDRO

```bash
npm test
bash db/testes/cobertura.sh
```

> "297 testes, nenhuma falha. Cobertura global de **88,8%**, contra os 60% que
> o nosso próprio requisito não funcional exige — e o CI **bloqueia merge**
> abaixo disso."

> "Uma coisa que a gente fez de propósito: `App.jsx`, o componente React, está
> com **0% de cobertura e aparece no denominador**. Testá-lo exigiria um
> segundo executor de testes no projeto, e a gente decidiu não pagar isso.
> Podia ter excluído do cálculo e mostrado 92%. Não excluiu: a lacuna aparece
> no número em vez de sumir."

> "E o CI faz mais do que rodar teste: ele **derruba uma constraint de
> propósito e exige que o teste acuse**. Teste que não falha quando a regra
> some não prova nada."

---

## Bloco 5 — Fechamento (1 min) · DANIEL

> "O escopo comprometido está entregue, e mais: dos dez requisitos de
> prioridade Alta que o planejamento dava como não atendidos, **nove já
> estavam implementados e o décimo fechou agora**. Resta um — a atualização
> do lance em tempo real por WebSocket, que continua como escopo adicional e
> hoje é resolvida por consulta periódica."

> "O que a gente leva do projeto não é o leilão. É que **regra crítica em
> sistema distribuído não mora no código, mora no banco** — e que verificação
> que não falha quando a regra some não é verificação."

---

## Arguição — quem responde o quê

| Pergunta provável | Quem | Resposta |
|---|---|---|
| Por que oito bancos em vez de um? | Daniel | Acoplamento. Um banco só faz qualquer serviço poder ler a tabela do outro, e aí o contrato vira a tabela. A separação é imposta por usuário do Postgres, não por combinação. |
| Isso não é overengineering para um TCC? | Daniel | O requisito do termo de aceite pede microsserviços. E a serialização de lance — o núcleo — não fica mais simples num monolito: o problema é concorrência, não distribuição. |
| Por que `FOR UPDATE` e não otimista com retry? | José | Lance é disputa real: sob contenção alta, retry otimista vira tempestade de reprocessamento. `FOR UPDATE` enfileira, e a espera é o comportamento correto aqui. |
| E se o serviço cair entre o commit e o envio do evento? | José | Não cai: o evento é gravado na mesma transação, na tabela `outbox`. Um publicador separado lê de lá. É o padrão outbox, documentado no ADR-007. |
| `now()` não bastaria para o prazo? | José | Não. `now()` é `transaction_timestamp()`: congela no início da transação. Como o lance espera na fila da trava, ele seria julgado com o relógio de antes da espera e poderia entrar depois do fim. Usamos `clock_timestamp()`. |
| 88,8% de cobertura, mas o frontend está em 0% | Leandro | É deliberado e está escrito no código. Testá-lo exigiria um segundo executor. A gente deixou no denominador em vez de excluir — podia estar mostrando 92%. |
| O que não foi feito? | Daniel | RF-015, tempo real por WebSocket. A interface consulta periodicamente. Está declarado como escopo adicional desde o planejamento, não é descoberta de última hora. |
| Isso roda na AWS ou só local? | José | Terraform em três camadas, ECS Fargate, RDS, SNS/SQS. A camada persistente já tem os tópicos e filas; a efêmera implanta parte dos serviços. O que está no ar é o que o Learner Lab permite manter. |

---

## Se algo der errado ao vivo

| Sintoma | O que fazer |
|---|---|
| A tela não abre | `cat .demo-logs/web.log`. Se o Vite não subiu, rode `npm run web` à parte. |
| Login dá erro de rede | AUTH caiu: `cat .demo-logs/auth.log`. O script já teria avisado se não subisse. |
| `connect ECONNREFUSED ::1:5432` | Postgres parado. `npm run db:up`. |
| Teste falha na hora | **Não tente consertar na frente da banca.** Mostre o teste rodando verde no último CI: `gh run list -R zzin742/arremate`. |

**Regra do dia:** se a demonstração ao vivo travar, passe para o terminal e
rode os testes. Eles são a evidência que o critério de sucesso do MVP exige —
a tela é ilustração, o teste é a prova.
