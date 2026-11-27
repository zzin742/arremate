# Registro de Decisões Arquitetônicas (ADR)

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Responsável por este documento:** José Henrique Teixeira Luiz (3225002)
**Versão:** 1.0 — 27/11/2026

---

## 1. Objetivo

Este documento registra as decisões arquitetônicas do Na Régua: o contexto que
as motivou, o que foi decidido, o que foi descartado e **o que se aceitou
perder em troca**.

A última parte é a que importa. Decisão sem consequência declarada é
preferência; o que torna uma decisão defensável é saber o que ela custou.

---

## ADR-001 — Arquitetura em microsserviços

### Contexto

O termo de aceite exige microsserviços e recusa monólitos. Mas a exigência
externa não é justificativa técnica, e a banca vai perguntar se a divisão faz
sentido no problema.

O Na Régua tem partes com perfis de carga genuinamente diferentes. O
agendamento vê rajada: todo mundo marca no mesmo horário de pico, e a disputa
pelo mesmo slot é o momento crítico. O catálogo é lido muito e escrito pouco. A
notificação é assíncrona por natureza e não pode, em hipótese alguma, segurar
um agendamento.

### Decisão

**Oito serviços**, com banco lógico e usuário próprios:

| Sigla | Responsabilidade |
|---|---|
| `auth` | conta, sessão, token |
| `bar` | barbearia: perfil, horário de funcionamento, membros |
| `cat` | serviços, barbeiros, expediente, bloqueios |
| `agd` | **agendamento — o núcleo** |
| `ass` | planos e assinaturas |
| `ava` | avaliações |
| `pag` | pagamento da barbearia à plataforma |
| `not` | notificação |

### Alternativas consideradas

| Alternativa | Prós | Contras |
|---|---|---|
| Monólito modular | Transação única entre módulos; menos peças para operar; mais rápido de construir | O termo recusa; e o `agd` não escalaria separado do resto, que é justamente o que o perfil de carga pede |
| Dois serviços (API + worker) | Separa o assíncrono do síncrono, que é a divisão com mais retorno | Não atende à exigência, e não isola o `agd` |
| Oito serviços | Escala e falha por serviço; fronteira explícita entre domínios | Consistência eventual; mais peças; rede entre chamadas |

### Consequências

**O que se perdeu:** a transação única. Marcar um corte por assinatura toca
`agd` e `ass`, e não há como fazer os dois num `BEGIN`. A saída é o evento com
consumo idempotente, e o preço é que existe um intervalo em que o agendamento
já existe e o plano ainda não foi descontado.

**O que se ganhou:** o `agd` escala de 2 a 4 tarefas sozinho, e uma falha no
`not` — provedor de e-mail fora do ar — não derruba agendamento nenhum.

> **Honestidade sobre o tamanho.** Oito serviços para o volume de uma barbearia
> de bairro é mais do que o problema pede. A decisão é defensável pelo
> requisito do termo e pelo perfil de carga do `agd`, não por necessidade de
> escala. Dizer o contrário na banca seria inventar uma justificativa.

---

## ADR-002 — A regra crítica mora no banco, não na aplicação

### Contexto

A regra que o produto existe para garantir é uma: **nunca dois atendimentos
vivos na mesma cadeira ao mesmo tempo.**

O caminho intuitivo é consultar "esse horário está livre?" e, se estiver,
inserir. Entre a consulta e o INSERT existe uma janela. Num horário disputado —
sábado de manhã, o barbeiro mais pedido — dois clientes tocam "agendar" no
mesmo segundo. Os dois leem "livre". Os dois inserem.

O resultado é a barbearia com dois clientes na porta para a mesma cadeira, e
nenhum log dizendo o que aconteceu.

### Decisão

A regra é uma **constraint do PostgreSQL**:

```sql
CONSTRAINT cadeira_ocupada_uma_vez EXCLUDE USING gist (
  id_barbeiro WITH =,
  tsrange((dia + comeca_em), (dia + termina_em), '[)') WITH &&
) WHERE (status IN ('agendado', 'concluido'))
```

A aplicação **não verifica** disponibilidade antes de inserir. Ela insere, e
traduz `exclusion_violation` (SQLSTATE 23P01) em recusa de negócio com código
próprio.

### Três detalhes que decidem se a regra está certa

| Detalhe | Por quê |
|---|---|
| `'[)'` e não `'[]'` | Um atendimento que termina às 10h30 não pode bloquear o que começa às 10h30. Com `'[]'` a agenda perderia um horário a cada corte. |
| `WHERE status IN (...)` | Sem o filtro, um atendimento cancelado continuaria ocupando a cadeira para sempre. |
| `concluido` dentro do filtro | Concluído **ocupou** a cadeira. Liberá-lo permitiria marcar por cima do histórico e quebraria o relatório do dono. |

### Alternativas consideradas

| Alternativa | Por que foi descartada |
|---|---|
| Verificar e inserir na aplicação | Tem janela. É o defeito que a decisão existe para eliminar. |
| `SELECT ... FOR UPDATE` na linha do barbeiro | Funciona, e serializa agendamentos do mesmo barbeiro numa fila. Mas serializa **todos**, inclusive horários que não conflitam entre si. A `EXCLUDE` só recusa o que de fato se sobrepõe. |
| Lock distribuído no Redis | Mais peças, e o lock pode expirar antes do COMMIT. Garantia pior do que a que o banco já dá de graça. |

### Consequências

**O que se perdeu:** a mensagem de erro do Postgres é opaca, e a aplicação
precisa traduzir o SQLSTATE. Um `catch` esquecido vira HTTP 500 em vez de "esse
horário acabou de ser preenchido".

**O que se ganhou:** a garantia não depende de a aplicação lembrar. Se o código
tiver bug, o banco ainda recusa.

**Pré-requisito:** a extensão `btree_gist`. Sem ela o Postgres recusa a
constraint, porque `uuid` não tem classe de operador gist padrão:

```
ERROR: data type uuid has no default operator class for access method "gist"
```

### Verificação

`npm test --workspace @naregua/agd` dispara **30 pedidos simultâneos** para o
mesmo barbeiro e horário. Exatamente um é aceito; os 29 restantes recebem
`horario_ocupado`. O teste também prova o contrário, onde importa: outra cadeira
no mesmo horário é aceita, horário encostado é aceito, e cancelar libera.

---

## ADR-003 — Um banco lógico e um usuário por serviço

### Contexto

A ADR-001 exige que nenhum serviço leia a tabela de outro. Essa exigência
precisa ser **imposta**, não combinada: acordo entre desenvolvedores sobrevive
até a primeira sexta-feira com prazo apertado.

### Decisão

**PostgreSQL 16**, uma instância, com **oito bancos lógicos e oito usuários**.
Cada serviço conecta com `svc_<sigla>` e só tem permissão no próprio banco:

```sql
REVOKE CONNECT ON DATABASE naregua_agd FROM PUBLIC;
GRANT  CONNECT ON DATABASE naregua_agd TO svc_agd;
```

Referência a entidade de outro serviço entra como `UUID` **sem chave
estrangeira**. A integridade entre serviços é garantida por evento.

### Alternativas consideradas

| Alternativa | Prós | Contras |
|---|---|---|
| Um banco, oito schemas | Mais simples; FK entre serviços funciona | A FK é exatamente o acoplamento que a ADR-001 quer evitar: mudar uma coluna quebra o vizinho |
| Uma instância RDS por serviço | Isolamento físico real | Oito instâncias não cabem no crédito do Learner Lab |
| PostgreSQL com bancos lógicos | ACID; constraints resolvem as regras críticas; cabe no orçamento | Compartilha capacidade e ponto de falha |
| MongoDB | Schema flexível | Sem equivalente ao `EXCLUDE`: a regra da cadeira teria de voltar para o código, que é o que a ADR-002 rejeita |

### Consequências

**O que se perdeu:** não existe FK entre serviços, então um `id_barbeiro` no
`agd` pode apontar para um barbeiro que o `cat` apagou. O sistema tolera isso: o
agendamento histórico continua válido mesmo se o barbeiro saiu da barbearia.

**O que se perdeu também:** uma instância compartilhada é ponto único de falha.
Aceito conscientemente — o Learner Lab não comporta oito.

---

## ADR-004 — Comunicação por evento, com outbox

### Contexto

Quando o `agd` marca um atendimento, três coisas precisam acontecer depois: o
`not` avisa o cliente, o `ass` desconta do plano se for por assinatura, e o
`ava` libera a avaliação quando o atendimento for concluído.

Fazer isso por chamada HTTP tem um defeito grave: se o `not` estiver fora do
ar, o agendamento falha. **Notificação não pode derrubar agendamento.**

Publicar o evento depois do COMMIT tem outro: se o processo morrer entre o
COMMIT e a publicação, o atendimento existe e ninguém fica sabendo. Não há log
desse caso — ele é invisível.

### Decisão

**Outbox.** O evento é gravado numa tabela `outbox`, **na mesma transação** da
mudança de estado. Um publicador separado lê a tabela e publica em SNS, que
entrega em SQS, de onde os consumidores leem.

```
agd ──[mesma transação]──> outbox ──> SNS ──> SQS ──> not, ass, ava
```

### Consequências

**O que se perdeu:** a entrega é **ao menos uma vez**, nunca exatamente uma. O
mesmo evento chega duas vezes, e todo consumidor precisa ser idempotente. Isso
não é detalhe de implementação: é obrigação de quem escreve cada consumidor, e
está imposta no banco de cada serviço —

| Serviço | Como |
|---|---|
| `ass` | `UNIQUE (id_agendamento)` em `uso_assinatura` — descontar duas vezes do plano cobraria o cliente por um corte que ele fez uma vez |
| `ava` | `UNIQUE (id_agendamento)` em `avaliacao` |
| `not` | `UNIQUE (id_evento)` em `notificacao` — sem isso o cliente recebe o mesmo lembrete duas vezes |
| `pag` | `UNIQUE (id_evento_externo)` — webhook repetido não lança o pagamento duas vezes |

**O que se perdeu também:** consistência eventual. Existe um intervalo de
segundos em que o atendimento está marcado e o cliente ainda não foi avisado.

**O que se ganhou:** o provedor de e-mail fora do ar não impede ninguém de
marcar um corte.

---

## ADR-005 — Espelho local do expediente, em vez de consulta ao CAT

### Contexto

Para decidir se um horário pode ser agendado, o `agd` precisa saber se o
barbeiro trabalha naquele dia e naquela faixa. Esse dado é do `cat`.

A consulta acontece **dentro da transação** do agendamento. Há três formas de
obter o dado, e duas quebram algo:

| Forma | Problema |
|---|---|
| HTTP ao `cat` dentro da transação | Segura a transação durante uma chamada de rede. Todo agendamento daquele barbeiro fica enfileirado atrás dela. |
| HTTP ao `cat` antes de abrir a transação | O dado pode mudar entre ler e gravar — é a mesma janela que a ADR-002 existe para eliminar. |
| Espelho local, alimentado por evento | Consulta local, dentro da transação. |

### Decisão

O `cat` publica `expediente_mudou`. O `agd` consome e mantém
`expediente_espelho` e `bloqueio_espelho` no próprio banco. **Essas tabelas não
são fonte de verdade** — a verdade é o `cat`; aqui é cópia para leitura.

### Consequências

**O que se perdeu:** consistência eventual visível ao usuário. O barbeiro muda
o expediente e leva alguns segundos para valer, enquanto o evento percorre
outbox → SNS → SQS.

**O que se ganhou:** o agendamento não depende da latência de outro serviço.

> **Por que isto não virou constraint.** Seria possível impor o expediente no
> banco do `agd`. Mas a regra dependeria de dado replicado, e a constraint
> recusaria agendamento legítimo durante os segundos em que o espelho está
> atrasado. Conferir na aplicação deixa a decisão explícita e o erro legível.
> É o oposto da ADR-002, e de propósito: lá o dado é local e a regra é
> absoluta; aqui o dado é cópia e a regra tolera atraso.

---

## ADR-006 — O prazo é julgado pelo relógio do banco

### Contexto

Agendamento no passado tem de ser recusado. A conferência precisa de um
relógio, e existem dois disponíveis: o da aplicação (`Date.now()`) e o do banco
(`clock_timestamp()`).

Usar os dois é o erro. Se a aplicação estiver atrasada em relação ao banco, um
horário que já passou é aceito; se estiver adiantada, um horário válido é
recusado. O desvio entre um contêiner Postgres e o host no macOS já foi medido
em **1,7 s** em outro projeto da mesma disciplina.

### Decisão

O prazo é conferido por `clock_timestamp()`, **dentro da transação**, com o
fuso `America/Sao_Paulo` explícito.

`clock_timestamp()` e não `now()`: `now()` é sinônimo de
`transaction_timestamp()` e congela no início da transação. Como a transação
pode esperar na fila, `now()` daria o relógio de **antes** da espera.

### Consequências

Um relógio só decide. O custo é uma ida ao banco a mais por agendamento, o que
é irrelevante perto de já estarmos numa transação aberta.

---

## ADR-007 — Reaproveitamento do esqueleto de infraestrutura

### Contexto

O Terraform em três camadas, a esteira de CI/CD, a stack de Prometheus e
Grafana, o medidor de cobertura e o pacote compartilhado com outbox e consumidor
vieram prontos de outro projeto do mesmo autor na mesma disciplina — o
**Arremate**, Projeto Experimental anterior deste grupo.

Vale declarar isso em vez de deixar a banca descobrir pelo histórico do Git.

### Decisão

Reaproveitar o esqueleto, e **registrar a origem**. O que foi reaproveitado é
infraestrutura genérica: provisionamento, esteira, observabilidade, medição.
Nenhuma regra de negócio veio junto — os oito serviços, o schema e as
constraints são deste projeto.

### Consequências

**O que se ganhou:** semanas de trabalho que teriam sido gastas reescrevendo
Terraform, e não aprendendo nada de novo.

**O que se perdeu:** algumas decisões do esqueleto foram herdadas em vez de
tomadas. A ordem das esperas do pool de conexões, por exemplo, veio de um
defeito encontrado por teste de carga no projeto anterior — está certa, mas o
mérito de tê-la descoberto não é deste trabalho.

---

## ADR-008 — Sessão de 12 horas

### Contexto

Token de sessão precisa de validade. O padrão que o projeto anterior usava era
uma hora.

### Decisão

**12 horas.** O cliente marca o corte de manhã e volta à tela de tarde para
conferir o horário; um token de uma hora o derrubaria no meio do dia, e a tela
não tem renovação silenciosa.

### Consequências

**O que se perdeu:** uma sessão roubada vale mais tempo.

A troca é consciente e depende do dano possível: neste sistema, o pior que uma
sessão roubada faz é marcar ou cancelar um corte. Não há transferência de
dinheiro — o pagamento do corte acontece no balcão, fora do sistema. Num
sistema com dado financeiro, esta decisão seria outra.
