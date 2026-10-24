# Arremate — o sistema em 5 minutos

Pra quem vai defender o projeto na banca e precisa entender o que ele faz,
por que foi feito assim, e onde estão as partes difíceis.

---

## O que é

Uma plataforma de **leilão online de máquinas e equipamentos industriais
usados** — tornos, prensas, empilhadeiras, compressores.

Hoje esse mercado acontece em grupo de WhatsApp e classificado genérico.
Quem vende não alcança comprador fora da região e acaba negociando abaixo do
valor. Quem compra não tem como confirmar o estado real da máquina nem se o
vendedor existe de fato. Não fica registro do que foi combinado.

**Dois lados:**

- **Vendedor** — indústria ou revenda com equipamento parado. Cadastra a
  máquina com ficha técnica e fotos, abre o leilão com prazo.
- **Comprador** — cadastra a empresa, deposita uma caução, dá lance. Pode
  agendar visita técnica pra ver a máquina antes.

---

## Por que microsserviços

O termo do projeto exige, mas tem motivo técnico próprio, e é bom saber
responder isso.

O sistema tem **dois perfis de carga que não se parecem**:

| | Lance | Conversão de vídeo |
|---|---|---|
| Duração | dezenas de milissegundos | minutos |
| Carga | rajada curta no fim do leilão | CPU constante |
| Alguém esperando? | sim, na tela | não |

No mesmo processo, um upload de 200 MB pode degradar a confirmação de um
lance. Separados, o serviço de leilão escala de 2 a 6 instâncias no horário
de disputa sem arrastar o resto.

**Se a banca perguntar se um monólito resolveria:** resolveria boa parte, sim.
Bulkhead e pools separados isolam CPU dentro de um monólito. A escolha por
microsserviços é em parte imposta pelo termo, e isso está escrito no nosso
documento 01. Admitir isso é mais forte que fingir que não.

---

## Os 8 serviços

| Sigla | Serviço | Responsabilidade |
|---|---|---|
| **AUTH** | Identidade | Cadastro, login, token de sessão |
| **HAB** | Habilitação | Verifica CNPJ na BrasilAPI e emite token de habilitação |
| **CAT** | Catálogo | Equipamento, ficha técnica, upload de mídia |
| **MID** | Mídia | Converte vídeo e gera miniatura (Python + FFmpeg) |
| **LEI** | Leilão | Abertura, lances, encerramento, arremate |
| **CAU** | Caução | Cobrança, webhook do provedor, devolução |
| **VIS** | Visita | Agendamento de visita técnica |
| **NOT** | Notificação | Avisa quem foi superado |

Cada um tem **banco próprio** e nenhum lê a tabela do outro. Quando o leilão
precisa do nome da empresa, ele pergunta ao AUTH — não copia o dado.

---

## A parte difícil: o lance

É o coração do projeto, e é o que a banca vai atacar.

**O problema:** nos segundos finais de um leilão, vários compradores dão lance
ao mesmo tempo. O sistema precisa garantir que dois lances de valor igual não
sejam aceitos, e que a ordem seja reconstituível depois.

**A solução:** o registro acontece sob `SELECT ... FOR UPDATE` na linha do
leilão. Dentro dessa trava, o sistema revalida o valor, grava com um número
de sequência único e escreve o evento — tudo na mesma transação.

```
  requisição chega
        ↓
  trava a linha do leilão    ← ninguém mais entra aqui
        ↓
  revalida contra o lance atual
        ↓
  grava lance + sequência + evento   (mesma transação)
        ↓
  solta a trava
```

**Duas perguntas prováveis da banca, e as respostas:**

*"Por que não trava otimista, com versão e retry?"* — Ela evita a trava na
leitura, mas o `UPDATE` condicional **também trava a linha** no Postgres: é
bloquear mais tarde, não deixar de bloquear. E o pico de lance é justamente
alta contenção, onde o retry vira cascata. Escolhemos a pessimista pela
simplicidade de raciocinar sobre ela.

*"Com valores crescentes, todos os lances são aceitos?"* — Só se forem
**enviados em ordem controlada**. Em concorrência real, o lance de 120 pode
pegar a trava antes do de 110, e aí **rejeitar o de 110 é o comportamento
correto**. A trava serializa o acesso; ela não ordena as requisições por
valor.

---

## O banco impõe as regras, não o código

Três regras críticas são **constraints do PostgreSQL**. Se o código errar, o
banco ainda recusa.

| Regra | Como |
|---|---|
| Duas visitas sobrepostas no mesmo equipamento | `EXCLUDE USING gist` |
| Dois leilões ativos pro mesmo equipamento | índice único **parcial** |
| Webhook de pagamento repetido | `UNIQUE (id_evento_externo)` |

O detalhe do índice **parcial** importa: ele só vale pros status `agendado` e
`aberto`. Sem isso, um equipamento nunca mais poderia ser releiloado depois
de um leilão encerrado.

E o webhook é deduplicado pelo **id do evento**, não da transação — uma
transação de pagamento gera vários eventos, e bloquear por transação perderia
eventos legítimos.

---

## Como os serviços conversam

**Síncrono (API), quando alguém espera resposta:** o leilão pergunta ao CAU se
a caução está reservada antes de aceitar o lance.

**Assíncrono (evento), quando ninguém espera:** conta criada, mídia enviada,
lance superado, leilão encerrado.

**Importante pro caminho do lance:** o LEI **não chama o HAB a cada lance**. O
HAB emite um token assinado com 15 minutos de validade, e o LEI verifica a
assinatura localmente. Chamada de rede no caminho crítico mataria a meta de
latência.

### Por que existe a "outbox"

Gravar o lance no banco e publicar o evento na fila são duas operações que
podem falhar entre si. Se o processo cair no meio, o lance existe mas ninguém
foi avisado — ou pior, a caução deveria ser liquidada e nunca será.

A solução: o evento é gravado numa tabela `outbox` **na mesma transação** do
lance. Ou os dois existem, ou nenhum. Um publicador lê os pendentes e envia.

**Isso garante publicação, não consumo.** Depois que a fila confirma, o
produtor considera entregue. Por isso as filas (SQS) ficam numa camada que
**nunca é destruída** — se o ambiente cair, a mensagem espera o consumidor
voltar.

---

## A nuvem, e por que custa pouco

AWS: ECS Fargate pros contêineres, RDS PostgreSQL, S3 pra mídia, SNS + SQS
pra mensageria, CloudFront na entrada.

Rodando o tempo todo, isso custaria **~US$ 246/mês** — fora do crédito do
laboratório da faculdade.

A solução é o Terraform em **três camadas**:

| Camada | O que tem | Destruída? |
|---|---|---|
| Bootstrap | estado do Terraform | nunca |
| Persistente | S3, imagens, **filas**, snapshots | nunca |
| Efêmera | servidores, banco, rede | **a cada sessão** |

Ligamos só quando vamos trabalhar. Custo real: **~US$ 12/mês**. As filas ficam
na camada persistente justamente pra nenhuma mensagem se perder no intervalo.

---

## O que já está pronto

Sprint 1, no `github.com/zzin742/arremate`:

- Monorepo com os 8 serviços
- Docker Compose: Postgres, Redis e LocalStack (simula S3, SNS e SQS)
- Os 7 bancos, um usuário por serviço, sem acesso cruzado
- **As constraints do banco, com teste provando que ele recusa** o que tem
  que recusar

Pra rodar:

```bash
npm run db:up
npm run test:db
```

Saem 9 confirmações, uma por regra. Vale rodar — em dez minutos você vê o
sistema de pé e entende mais do que lendo documento.

## O que falta até 07/12

O núcleo do leilão: AUTH (cadastro e login), abertura de leilão, **o lance com
a trava**, e uma tela mínima. Está nas sprints 2 e 3 do documento 08.

---

## Os 8 documentos

Já entregues, nos PRs #22 a #28 do repositório do professor:

`01` solicitação · `02` requisitos · `03` DFD · `04` MER ·
`05` arquitetura em nuvem · `06` C4 · `07` ADR · `08` sprints

O **07 (ADR)** é o mais útil pra estudar pra banca: cada decisão técnica com
contexto, alternativas consideradas e o que se perdeu em troca. Inclusive as
duas decisões que **tomamos e depois derrubamos**, com o motivo — é disso que
banca gosta.
