# Divisão do trabalho

**Grupo:** José Henrique Teixeira Luiz (3225002) · Daniel de Oliveira Tavares
Júnior (6325032) · Leandro Duarte (6325072)

O professor pediu que cada integrante tenha trabalho próprio no projeto, com
commits na sua frente. Este documento define as três frentes, o que cada uma
entrega, e o que cada um precisa saber para defender a sua na banca — porque é
isso que a arguição vai cobrar, não o número de commits.

As frentes foram escolhidas para serem **independentes**: cada uma tem os seus
bancos, os seus serviços e o seu contrato. Ninguém fica esperando o outro
terminar para começar.

---

## Por que esta divisão e não outra

Os oito serviços não têm o mesmo peso. O `agd` concentra a regra que o produto
existe para garantir e é onde a concorrência acontece; os demais são
bem-comportados. Dividir "dois serviços para cada um" distribuiria linhas, não
responsabilidade.

A divisão abaixo separa por **tipo de problema**:

| Frente | Problema que ela resolve |
|---|---|
| Núcleo e infraestrutura | concorrência, identidade, e a nuvem inteira |
| Dados e catálogo | modelagem, separação entre bancos, consulta |
| Eventos e borda | comunicação assíncrona, e o que o usuário vê |

Cada uma tem uma pergunta técnica de verdade para defender.

---

## José — Núcleo e infraestrutura

**Serviços:** `agd`, `auth`
**Infra:** Terraform, GitHub Actions, Prometheus, Grafana
**Documentos:** 05 (Arquitetura em Nuvem), 07 (ADR), 08 (Planejamento)

### O que entregar

- `services/agd` — agendar, cancelar, remarcar, listar a agenda do dia.
  A regra crítica já está no banco (`EXCLUDE USING gist`); o serviço traduz a
  recusa do Postgres em resposta de negócio, com código próprio, em vez de
  deixar vazar um erro 500.
- `services/auth` — cadastro, login, token de sessão.
- Teste de concorrência: N pedidos simultâneos para o mesmo barbeiro e horário,
  **exatamente um aceito**, nenhum confirmado ausente do banco.
- Terraform em três camadas, esteira de CI/CD, stack de monitoramento no ar.

### O que saber defender

> **Por que a regra está no banco e não no código?**
> Entre verificar "está livre" e gravar existe uma janela. Sob dois cliques
> simultâneos ela é alcançada, e os dois agendamentos entram. A constraint não
> tem janela: o segundo INSERT é recusado pelo Postgres, sempre.

> **Por que `'[)'` e não `'[]'` no intervalo?**
> Com `'[]'` um atendimento que termina às 10h30 bloquearia o que começa às
> 10h30, e a agenda perderia um horário a cada corte.

> **Por que o `WHERE status IN (...)` na constraint?**
> Sem ele, um atendimento cancelado continuaria ocupando a cadeira para sempre.

---

## Daniel — Dados e catálogo

**Serviços:** `bar`, `cat`
**Documentos:** 03 (Fluxo de Dados), 04 (MER)

### O que entregar

- `services/bar` — barbearia: cadastro, perfil público, horário de
  funcionamento, fechamentos, convite e papel dos membros.
- `services/cat` — serviços, barbeiros, expediente semanal, bloqueios.
- Publicar o evento `expediente_mudou` quando o expediente ou um bloqueio
  mudar: é dele que o `agd` alimenta o espelho local.
- Testes das regras próprias: uma barbearia tem um dono só; bloqueios não se
  sobrepõem; serviço inativo não aparece na vitrine.

### Rotas a implementar

```
POST   /barbearias                      cria (quem cria vira dono)
GET    /barbearias/:apelido             perfil público
PUT    /barbearias/:id/horarios         horário de funcionamento
POST   /barbearias/:id/membros          convida
POST   /membros/:id/aceitar             aceita o convite

POST   /servicos                        cria serviço
GET    /barbearias/:id/servicos         vitrine
POST   /barbeiros                       cria barbeiro
PUT    /barbeiros/:id/expediente        define o expediente  → publica evento
POST   /barbeiros/:id/bloqueios         bloqueia um período  → publica evento
```

### O que saber defender

> **Por que o `agd` tem uma cópia do expediente em vez de perguntar ao `cat`?**
> Porque a consulta acontece dentro da transação do agendamento. Uma chamada
> HTTP ali dentro seguraria a transação pelo tempo da rede, e todo agendamento
> daquele barbeiro ficaria na fila atrás dela. O preço é consistência eventual:
> mudar o expediente leva alguns segundos para valer. A fonte de verdade
> continua sendo o `cat`.

> **Por que um banco por serviço, se é tudo o mesmo Postgres?**
> Para que nenhum serviço possa ler a tabela do outro. A separação é imposta
> por usuário do Postgres — `REVOKE CONNECT` do público, um `svc_<sigla>` por
> banco — e não por combinação entre nós. Com um banco só, o contrato entre
> serviços viraria a tabela, e mudar uma coluna quebraria o vizinho.

---

## Leandro — Eventos e borda

**Serviços:** `ava`, `not`, `pag`
**Frontend:** integração das telas com os serviços
**Documentos:** 01 (Solicitação do Sistema), 02 (Requisitos), 06 (C4)

### O que entregar

- `services/not` — consome evento e notifica. **Nunca é chamado por HTTP por
  outro serviço**, e é isso que garante que notificação jamais bloqueie um
  agendamento.
- `services/ava` — avaliação do atendimento, uma por atendimento, só para quem
  foi atendido.
- `services/pag` — pagamento da barbearia à plataforma, com webhook idempotente.
- Ligar as telas do Na Régua (design e imagens já existem) aos serviços.
- Testes: evento entregue duas vezes não notifica duas vezes; avaliação de
  atendimento que não houve é recusada; webhook repetido não lança o pagamento
  duas vezes.

### O que saber defender

> **Por que notificação é por evento e não por chamada direta?**
> Se o `agd` chamasse o `not` por HTTP, o provedor de e-mail fora do ar
> derrubaria o agendamento junto. Por evento, o corte é marcado e a notificação
> sai quando der.

> **A entrega do evento é "ao menos uma vez". Como o cliente não recebe o mesmo
> lembrete duas vezes?**
> Pelo `UNIQUE (id_evento)` na tabela `notificacao`. A segunda tentativa de
> gravar falha, e o envio não acontece. A mesma estratégia está no `pag`, com
> `id_evento_externo`.

---

## Como trabalhar sem pisar um no outro

1. **Uma branch por frente**, com o nome da pessoa:
   `frente/agd-auth-jose`, `frente/bar-cat-daniel`, `frente/eventos-leandro`.
2. **Cada um commita da própria máquina, com a própria conta.** O histórico é a
   prova de participação que a banca vai olhar; commit feito por outro com a
   chave alheia é registro falso, e é exatamente o que o professor está
   checando.
3. **Trabalho feito a quatro mãos** leva `Co-Authored-By:` com o e-mail real do
   outro. É o mecanismo honesto para isso, e aparece no histórico do GitHub.
4. **Contrato antes de código.** As rotas acima são o acordo. Quem muda uma
   rota avisa os outros dois antes, não depois.
5. **Nada de editar a pasta do outro.** Se precisar de algo do serviço vizinho,
   peça a rota ou o evento — é o mesmo que acontece num time de verdade.

---

## Se alguém não conseguir codar a sua frente

Vale dizer isto em voz alta agora, em vez de descobrir em dezembro: o
planejamento do semestre passado registrou que a capacidade real de
desenvolvimento do grupo é de uma pessoa. Se isso continuar valendo, há duas
saídas honestas, e nenhuma delas é alguém commitar no lugar do outro:

- **Programação em par de verdade.** Os dois na mesma tela, e o commit sai com
  `Co-Authored-By`. A participação é real e o registro também.
- **Frentes que não são código, e que o projeto precisa.** Os 8 documentos, o
  roteiro de demonstração e o ensaio, os dados de exemplo, o teste de carga, o
  levantamento de requisitos com barbearias reais. Tudo isso entra no
  histórico, tudo isso a banca avalia, e nada disso é figuração.

O que não funciona é um nome no documento sem trabalho atrás. A arguição é
individual: cada um responde pela sua frente na frente da banca, e lá não tem
como o outro responder no lugar.
