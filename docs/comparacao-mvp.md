# Documento recebido × arquitetura aprovada

Comparação entre `docs/recebidos/mvp-proposta-daniel.md` e os documentos 01 a
08, entregues nos PRs #22 a #28 e aprovados em revisão técnica.

**Resumo:** o documento recebido tem **uma contribuição que vale adotar**,
**três divergências que quebram critério obrigatório ou documento aprovado**, e
algumas diferenças que são só de nomenclatura.

---

## 1. O que ele acertou e nós não tínhamos

### `clock_timestamp()` em vez de `now()` — adotar

> *"o prazo é comparado com `clock_timestamp()`, não com `now()`. O `now()`
> congela no início da transação; quem esperou na fila da trava seria avaliado
> com horário antigo e poderia lançar depois do fim."*

Isso está **certo e é importante**, e não aparece em nenhum dos nossos oito
documentos.

No PostgreSQL, `now()` é sinônimo de `transaction_timestamp()`: o valor é
fixado no início da transação e não muda. Como o lance espera na fila do
`SELECT ... FOR UPDATE`, uma requisição pode ficar parada segundos ali. Se o
prazo for comparado com `now()`, ela é avaliada com o relógio de **antes** da
espera — e um lance depois do encerramento seria aceito.

**Ação:** usar `clock_timestamp()` na revalidação do prazo dentro da trava, e
registrar isso como nota no documento 04 ou como ADR nova.

---

## 2. Divergências que precisam de decisão

### 2.1 Falta o serviço de habilitação — risco de critério

A lista de oito serviços do documento recebido **não tem o HAB**. Os nossos:

| Aprovado | Recebido |
|---|---|
| AUTH identidade | identidade |
| **HAB habilitação** | *(não existe)* |
| CAT catálogo | equipamentos |
| MID mídia | midia |
| LEI leilão | leiloes **+** lances (dois serviços) |
| CAU caução | pagamentos |
| VIS visita | visitas |
| NOT notificação | notificacoes |

O HAB é quem consulta o **CNPJ na BrasilAPI**. Essa é a nossa **integração com
API externa**, que é um dos dez critérios obrigatórios do termo:

> *"Integração com pelo menos uma API externa."*

Sem o HAB, some a única API externa do projeto. O documento recebido também
dividiu LEI em dois serviços e depois anotou que eles compartilham banco —
o que contraria a regra de um banco por serviço que ele mesmo enuncia.

### 2.2 "Réplica local" contradiz o MER aprovado

Documento recebido, seção 3:

> *"Dados de outro serviço chegam por evento e ficam em **réplica local**.
> Exemplo: o serviço de lances mantém a tabela `caucoes_ativas`."*

MER aprovado, seção 7:

> *"**O id é a fronteira.** Cada serviço guarda apenas o identificador das
> entidades de fora, **nunca uma cópia dos dados**. Quando o leilão precisa do
> nome da empresa, pergunta ao AUTH."*

São estratégias opostas, e a diferença é real. Réplica local é mais rápida na
leitura e cria o problema de dado desatualizado: se a caução for cancelada e o
evento se perder, o serviço de lances aceita lance de quem não tem mais
caução. A nossa escolha foi **reserva no CAU consultada no momento do lance**,
justamente para não ter esse estado duplicado.

Mudar isso agora significa reescrever o MER e o C4, que já estão entregues.

### 2.3 Python no serviço de lances contradiz a ADR-002

O MVP recebido é FastAPI + pytest. A **ADR-002**, aprovada, define Node.js com
Express nos sete serviços de E/S, e Python **só no worker de mídia**, porque é
lá que o FFmpeg vive.

Não é que Python esteja errado — é que a decisão já foi registrada, com
alternativas e consequências, num documento entregue. Trocar exige
**substituir a ADR-002**, não ignorá-la.

---

## 3. Diferenças pequenas

| Ponto | Aprovado | Recebido | Comentário |
|---|---|---|---|
| Filtro do `EXCLUDE` | `WHERE status = 'agendada'` | `WHERE status <> 'CANCELADA'` | O deles inclui visita já realizada, o que **bloquearia** reagendar o equipamento depois de uma visita concluída. O nosso é mais correto |
| Chave do webhook | `UNIQUE (id_evento_externo)` | `UNIQUE (provedor, evento_id)` | O deles é melhor se houver mais de um provedor. Vale adotar |
| Status do leilão | minúsculo (`aberto`) | maiúsculo (`ABERTO`) | Só convenção |

---

## 4. O que já está feito, dos dois lados

| | Recebido | Nosso (Sprint 1) |
|---|---|---|
| Constraints no banco | escritas | escritas |
| Testes | escritos | escritos |
| **Testes executados** | **não** — *"sem Postgres disponível"* | **sim**, 9 asserções |
| CI | não | sim, verde |
| Teste prova que pega regra ausente | não | sim — derruba a constraint e exige falha |

O documento recebido declara honestamente que os testes nunca rodaram. Os
nossos rodam no CI a cada push.

---

## 5. Recomendação

**Adotar:**

1. `clock_timestamp()` na revalidação do prazo — é uma correção real
2. `UNIQUE (provedor, id_evento_externo)` no webhook
3. Os **casos de uso UC01 a UC10** como material de apresentação. Eles estão
   bem escritos e cobrem o que o professor pediu no documento de MVP

**Não adotar sem decisão do grupo e do orientador:**

4. A divisão de serviços sem HAB — perderia a API externa, critério obrigatório
5. Réplica local de dados — contradiz o MER aprovado
6. Python no serviço de lances — contradiz a ADR-002 aprovada

**Por quê:** os oito documentos estão entregues e aprovados. Desenvolver contra
uma arquitetura diferente da documentada cria a pior situação possível na
banca — o documento dizendo uma coisa e o código fazendo outra. Se o grupo
preferir a arquitetura do documento recebido, o caminho é **atualizar os
documentos primeiro** e avisar o orientador, não deixar os dois divergirem.
