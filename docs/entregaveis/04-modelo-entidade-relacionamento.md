# Modelo Entidade-Relacionamento

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Versão:** 1.0 — 27/11/2026

---

## 1. Objetivo

Modelar a estrutura de dados do Na Régua, justificar a escolha da tecnologia de
persistência e documentar como os dados se distribuem entre os microsserviços.

---

## 2. Justificativa da escolha: PostgreSQL 16

A decisão completa, com as alternativas descartadas, está na
[ADR-003](07-registro-decisoes-arquitetonicas-adr.md). O resumo técnico:

| Necessidade do projeto | O que o PostgreSQL oferece |
|---|---|
| **Impedir duas marcações na mesma cadeira sob concorrência** | `EXCLUDE USING gist` com tipo de intervalo. É a razão principal da escolha |
| Transação entre tabelas do mesmo serviço | ACID |
| Uma regra valendo só em alguns estados | Índice único **parcial** (`WHERE`) |
| Separação real entre serviços | Um banco lógico e um usuário por serviço |

**Por que não NoSQL.** MongoDB tem transação ACID multi-documento, mas não tem
equivalente ao `EXCLUDE`. A regra da cadeira voltaria para o código da
aplicação — exatamente o que a ADR-002 rejeita, porque lá ela tem uma janela
entre verificar e gravar.

**Por que não um banco por serviço em instâncias separadas.** Oito instâncias
RDS não cabem no crédito do AWS Academy Learner Lab.

---

## 3. Distribuição por serviço

Cada serviço tem o seu banco lógico. **Referência a entidade de outro serviço é
um `UUID` sem chave estrangeira** — a integridade entre serviços é garantida
por evento, não por FK.

```
naregua_auth        naregua_bar           naregua_cat
┌──────────────┐    ┌──────────────┐      ┌──────────────┐
│ conta        │    │ cidade       │      │ servico      │
│ bloqueio_    │    │ barbearia    │      │ servico_     │
│   conta      │    │ horario_     │      │   inclui     │
└──────────────┘    │   barbearia  │      │ barbeiro     │
                    │ fechamento   │      │ barbeiro_    │
                    │ membro       │      │   servico    │
                    └──────────────┘      │ expediente   │
                                          │ bloqueio     │
                                          │ comissao_    │
                                          │   por_servico│
                                          └──────────────┘

naregua_agd                     naregua_ass
┌────────────────────┐          ┌──────────────┐
│ agendamento   ◀────┼──┐       │ plano        │
│ expediente_espelho │  │       │ plano_servico│
│ bloqueio_espelho   │  │       │ assinatura   │
└────────────────────┘  │       │ uso_         │
                        │       │   assinatura │
naregua_ava             │       └──────────────┘
┌────────────────────┐  │
│ avaliacao          │  │       naregua_pag      naregua_not
│ atendimento_espelho│  │       ┌──────────────┐ ┌──────────────┐
└────────────────────┘  │       │ pagamento_   │ │ notificacao  │
                        │       │   plataforma │ └──────────────┘
         espelhos ──────┘       └──────────────┘
      alimentados por evento
```

---

## 4. A tabela central: `agendamento`

```sql
CREATE TABLE agendamento (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  id_barbearia    UUID NOT NULL,   -- vive no banco do BAR
  id_barbeiro     UUID NOT NULL,   -- vive no banco do CAT
  id_servico      UUID NOT NULL,   -- vive no banco do CAT

  id_cliente      UUID,            -- conta no AUTH; NULL em encaixe
  nome_encaixe    VARCHAR(120),
  whatsapp_encaixe VARCHAR(20),

  dia             DATE NOT NULL,
  comeca_em       TIME NOT NULL,
  termina_em      TIME NOT NULL,

  status          status_agendamento NOT NULL DEFAULT 'agendado',
  origem          origem_agendamento NOT NULL DEFAULT 'site',

  valor_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  por_assinatura  BOOLEAN NOT NULL DEFAULT FALSE,
  id_assinatura   UUID,

  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT termina_depois_de_comecar CHECK (termina_em > comeca_em),
  CONSTRAINT tem_cliente_ou_encaixe
    CHECK (id_cliente IS NOT NULL OR nome_encaixe IS NOT NULL),

  CONSTRAINT cadeira_ocupada_uma_vez EXCLUDE USING gist (
    id_barbeiro WITH =,
    tsrange((dia + comeca_em), (dia + termina_em), '[)') WITH &&
  ) WHERE (status IN ('agendado', 'concluido'))
);
```

### 4.1 A constraint, linha por linha

| Trecho | O que faz | O que aconteceria sem ele |
|---|---|---|
| `EXCLUDE USING gist` | Recusa linhas cujos pares de valores se sobreponham | A regra voltaria para a aplicação, com a janela entre verificar e gravar |
| `id_barbeiro WITH =` | A exclusão só vale **dentro do mesmo barbeiro** | Uma barbearia não poderia ter dois clientes no mesmo horário em cadeiras diferentes |
| `tsrange(..., '[)')` | Intervalo fechado no início, aberto no fim | Com `'[]'`, 10h30 não poderia começar onde o outro terminou, e a agenda perderia um horário por corte |
| `WHERE status IN (...)` | A regra só vale para atendimento **vivo** | Um cancelado bloquearia a cadeira para sempre |
| `concluido` **dentro** do filtro | Concluído ocupou a cadeira | Seria possível marcar por cima do histórico, e o relatório do dono quebraria |

**Pré-requisito:** extensão `btree_gist`. Sem ela o PostgreSQL recusa a
constraint, porque `uuid` não tem classe de operador gist padrão:

```
ERROR: data type uuid has no default operator class for access method "gist"
```

### 4.2 Por que `DATE` + `TIME` e não `TIMESTAMPTZ`

A barbearia pensa em "sábado às 10h", não em um instante UTC. Guardando
separado, mudar o fuso do servidor não desloca a agenda inteira. A soma
`dia + comeca_em` dentro da constraint reconstrói o instante quando é preciso
comparar.

---

## 5. As demais regras impostas pelo banco

| Regra | Mecanismo | Tabela |
|---|---|---|
| Uma barbearia tem um dono só | índice único **parcial** `WHERE papel = 'dono'` | `membro` |
| Bloqueios do mesmo barbeiro não se sobrepõem | `EXCLUDE USING gist` | `bloqueio` |
| Uma assinatura viva por cliente e barbearia | índice único **parcial** por status | `assinatura` |
| O mesmo corte não desconta duas vezes do plano | `UNIQUE (id_agendamento)` | `uso_assinatura` |
| Uma avaliação por atendimento | `UNIQUE (id_agendamento)` | `avaliacao` |
| Webhook de pagamento repetido não lança duas vezes | `UNIQUE (id_evento_externo)` | `pagamento_plataforma` |
| O mesmo lembrete não sai duas vezes | `UNIQUE (id_evento)` | `notificacao` |

As quatro últimas existem por causa da ADR-004: a entrega de evento é **ao
menos uma vez**, e idempotência não é opcional.

> **Índice único parcial, e não constraint na aplicação.** Em todos os casos
> acima a tentação é resolver com um `if`. O problema é o mesmo da cadeira: a
> segunda assinatura e o segundo dono aparecem quando o usuário clica duas
> vezes, que é justamente quando duas transações correm juntas.

---

## 6. Enumerações

| Tipo | Valores |
|---|---|
| `status_agendamento` | `agendado`, `concluido`, `faltou`, `cancelado_pelo_cliente`, `cancelado_pela_barbearia` |
| `origem_agendamento` | `site`, `painel` |
| `papel_membro` | `dono`, `socio`, `funcionario` |
| `status_assinatura` | `aguardando_pagamento`, `ativa`, `vence_em_breve`, `vencida`, `inativa`, `cancelada` |
| `estado_uso` | `reservado`, `consumido` |
| `modo_cobranca` | `offline`, `online` |
| `etiqueta_servico` | `corte`, `barba`, `sobrancelha`, `lavagem`, `pezinho`, `hidratacao`, `pigmentacao`, `luzes`, `limpeza_pele`, `infantil` |
| `estado_envio` | `pendente`, `enviado`, `falhou` |

**Por que cancelamento tem dois valores.** O relatório do dono separa o que o
cliente desmarcou do que a barbearia desmarcou — são problemas diferentes, com
respostas diferentes.

---

## 7. Dinheiro

Todo valor monetário é **`INTEGER` em centavos**. Nunca `FLOAT` nem `NUMERIC`
com casas decimais implícitas.

Ponto flutuante acumula erro de arredondamento, e num sistema que calcula
comissão por serviço esse erro vira diferença no acerto entre o dono e o
barbeiro — a conversa mais sensível que o sistema toca.

---

## 8. Os espelhos

Três tabelas são cópia de leitura de dado que pertence a outro serviço:

| Tabela | Banco | Fonte de verdade | Alimentada por |
|---|---|---|---|
| `expediente_espelho` | `agd` | `cat` | `expediente_mudou` |
| `bloqueio_espelho` | `agd` | `cat` | `expediente_mudou` |
| `atendimento_espelho` | `ava` | `agd` | `atendimento_concluido` |

Elas existem porque a consulta acontece **dentro de uma transação**, e uma
chamada de rede ali dentro seguraria a transação pelo tempo do outro serviço
responder. O custo é consistência eventual, descrito na ADR-005.

Nenhuma delas tem constraint sobre o dado replicado: durante os segundos em que
o espelho está atrasado, uma constraint recusaria operação legítima.

---

## 9. Verificação

`npm run test:db` prova as regras acima **contra o banco**, e prova também o
contrário onde importa:

```
ok 1.1 — atendimento sobreposto recusado
ok 1.2 — outra cadeira no mesmo horário é aceita
ok 1.3 — horário encostado (10h30 após 10h30) é aceito
ok 1.4 — após cancelar, o horário fica livre
ok 1.5 — atendimento sem dono recusado
ok 2.1 — segundo dono recusado
ok 3.1 — bloqueio sobreposto recusado
ok 4.1 — segunda assinatura viva recusada
ok 4.3 — consumo repetido do plano recusado
ok 5.1 — segunda avaliação do mesmo atendimento recusada
ok 6.1 — pagamento repetido recusado
```

Provar só a recusa não basta: um banco que recusasse tudo passaria em metade
desses testes.
