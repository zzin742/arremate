# C4 Model

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Versão:** 1.0 — 27/11/2026

---

## 1. Objetivo

Descrever a arquitetura do Na Régua em três níveis de aproximação — contexto,
contêineres e componentes —, conforme o modelo C4.

Cada nível responde a uma pergunta diferente, e o erro comum é misturá-las:

| Nível | Pergunta |
|---|---|
| 1 — Contexto | Quem usa o sistema e com que outros sistemas ele fala? |
| 2 — Contêineres | Em que unidades executáveis o sistema se divide? |
| 3 — Componentes | Dentro de um contêiner, quais são as partes e o que cada uma faz? |

---

## 2. Nível 1 — Contexto

```
        ┌──────────┐                      ┌────────────────┐
        │ Cliente  │                      │ Google Places  │
        │ (pessoa) │                      │ (sistema       │
        └────┬─────┘                      │  externo)      │
             │ marca o corte              └────────┬───────┘
             │ pelo navegador                      │ avaliações
             ▼                                     │ públicas
    ╔════════════════════════════════════╗         │
    ║                                    ║◀────────┘
    ║           NA RÉGUA                 ║
    ║   Marketplace de barbearias        ║
    ║                                    ║─────────┐
    ╚════════════════════════════════════╝         │ cobrança
             ▲                                     ▼
             │ administra agenda,         ┌────────────────┐
             │ equipe e planos            │ Provedor de    │
        ┌────┴─────┐                      │ pagamento      │
        │  Dono /  │                      │ (sistema       │
        │ Barbeiro │                      │  externo)      │
        │ (pessoa) │                      └────────────────┘
        └──────────┘
```

| Ator | Papel |
|---|---|
| **Cliente** | Procura barbearia, vê horários livres, marca, cancela, avalia |
| **Dono / Barbeiro** | Cadastra serviços e equipe, define expediente, administra a agenda |
| **Google Places** | Fornece as avaliações públicas da barbearia. É a integração externa exigida pelo termo |
| **Provedor de pagamento** | Cobra a mensalidade da barbearia à plataforma e confirma por webhook |

---

## 3. Nível 2 — Contêineres

```
┌─ Navegador ────────────────────────────────────────────────┐
│  ┌──────────────────┐        ┌──────────────────┐          │
│  │ App do cliente   │        │ Painel da        │          │
│  │ React / Vite     │        │ barbearia        │          │
│  └────────┬─────────┘        └────────┬─────────┘          │
└───────────┼───────────────────────────┼────────────────────┘
            └──────────────┬────────────┘
                           │ HTTPS
                  ┌────────▼────────┐
                  │  ALB            │  /api/<servico>/*
                  └────────┬────────┘
   ┌───────────────────────┼───────────────────────────────┐
   │                       │                               │
┌──▼───┐  ┌──────┐  ┌──────┐  ┌───────┐  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐
│ AUTH │  │ BAR  │  │ CAT  │  │  AGD  │  │ ASS │  │ AVA │  │ PAG │  │ NOT │
│      │  │      │  │      │  │       │  │     │  │     │  │     │  │     │
│ Node │  │ Node │  │ Node │  │ Node  │  │Node │  │Node │  │Node │  │Node │
│ ECS  │  │ ECS  │  │ ECS  │  │ ECS   │  │ ECS │  │ ECS │  │ ECS │  │ ECS │
│      │  │      │  │      │  │ 2–4   │  │     │  │     │  │     │  │ só  │
│      │  │      │  │      │  │tarefas│  │     │  │     │  │     │  │cons.│
└──┬───┘  └──┬───┘  └──┬───┘  └───┬───┘  └──┬──┘  └──┬──┘  └──┬──┘  └──▲──┘
   │         │         │          │         │        │        │        │
   └─────────┴─────────┴──────────┴─────────┴────────┴────────┘        │
                           │                                            │
                  ┌────────▼────────┐                      ┌────────────┴──┐
                  │ RDS PostgreSQL  │                      │  SNS  →  SQS  │
                  │ 8 bancos lógicos│                      │   mensageria  │
                  │ 1 usuário cada  │                      └───────────────┘
                  └─────────────────┘
                  ┌─────────────────┐    ┌──────────┐
                  │ ElastiCache     │    │ S3       │
                  │ Redis (cache)   │    │ fotos    │
                  └─────────────────┘    └──────────┘
```

| Contêiner | Tecnologia | Responsabilidade |
|---|---|---|
| App do cliente | React, Vite | Busca barbearia, mostra horários, marca |
| Painel da barbearia | React, Vite | Agenda, equipe, serviços, planos, relatório |
| AUTH | Node + Express | Conta, sessão, token |
| BAR | Node + Express | Barbearia, horário, membros |
| CAT | Node + Express | Serviços, barbeiros, expediente, bloqueios |
| **AGD** | Node + Express | **Agendamento — o núcleo** |
| ASS | Node + Express | Planos e assinaturas |
| AVA | Node + Express | Avaliações |
| PAG | Node + Express | Pagamento da plataforma |
| NOT | Node, **só consumidor** | Notificação. Não expõe rota de negócio |
| RDS PostgreSQL | PostgreSQL 16 | Oito bancos lógicos, um usuário por serviço |
| ElastiCache | Redis | Cache de leitura |
| SNS + SQS | AWS | Transporte dos eventos |
| S3 | AWS | Fotos |

### Por que o NOT é diferente dos demais

Ele **não é chamado por HTTP por nenhum serviço**. Só consome fila. É isso que
garante que o provedor de e-mail fora do ar não derrube um agendamento — se
fosse chamada direta, a falha dele viraria falha do agendamento.

---

## 4. Nível 3 — Componentes do AGD

O AGD é o contêiner que vale detalhar: é onde a regra crítica mora.

```
┌───────────────────────────────────────────────────────────────┐
│ AGD                                                            │
│                                                                │
│  ┌─────────────────────────────────────────────────────┐      │
│  │ index.js — camada HTTP                               │      │
│  │                                                      │      │
│  │  · valida o corpo com Zod                            │      │
│  │  · exigirSessao: verifica o token por assinatura,    │      │
│  │    sem chamada de rede ao AUTH                       │      │
│  │  · traduz AgendamentoRecusado em status HTTP:        │      │
│  │      horario_ocupado   → 409                         │      │
│  │      nao_e_seu         → 403                         │      │
│  │      nao_encontrado    → 404                         │      │
│  │      demais            → 422                         │      │
│  │  · SemConexao          → 503 + Retry-After           │      │
│  └───────────────────────┬─────────────────────────────┘      │
│                          │                                     │
│  ┌───────────────────────▼─────────────────────────────┐      │
│  │ agendamentos.js — domínio                            │      │
│  │                                                      │      │
│  │  agendar()        confere o que a constraint não     │      │
│  │                   cobre, insere, traduz a recusa     │      │
│  │  cancelar()       idempotente; cliente só cancela    │      │
│  │                   o próprio                          │      │
│  │  concluir()       publica atendimento_concluido      │      │
│  │  marcarFalta()    libera a cadeira                   │      │
│  │  horariosLivres() consulta — NÃO é garantia          │      │
│  └───────────────────────┬─────────────────────────────┘      │
│                          │                                     │
│  ┌───────────────────────▼─────────────────────────────┐      │
│  │ db.js — pool, via @naregua/shared                    │      │
│  └───────────────────────┬─────────────────────────────┘      │
│                          │                                     │
│  ┌───────────────────────▼─────────────────────────────┐      │
│  │ consumidor de expediente_mudou                       │      │
│  │   mantém expediente_espelho e bloqueio_espelho       │      │
│  └──────────────────────────────────────────────────────┘      │
└───────────────────────────────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │  naregua_agd    │
                  │                 │
                  │  agendamento    │ ◀── cadeira_ocupada_uma_vez
                  │  expediente_esp.│      (EXCLUDE USING gist)
                  │  bloqueio_esp.  │
                  │  outbox         │
                  └─────────────────┘
```

### O que cada camada decide

| Camada | Decide | Não decide |
|---|---|---|
| `index.js` | Qual status HTTP cada recusa vira | Se o agendamento é válido |
| `agendamentos.js` | Expediente, bloqueio, horário no passado | **Se a cadeira está livre** |
| **Banco** | **Se a cadeira está livre** | — |

Essa última linha é o ponto do projeto. A disponibilidade da cadeira não é
decidida em nenhuma camada de código: é decidida no INSERT, pela constraint. A
aplicação não consulta antes — porque entre consultar e gravar existe uma
janela, e sob dois cliques simultâneos ela é alcançada.

### `horariosLivres()` é consulta, não reserva

O método existe para a tela montar a lista, e **não garante nada**. Entre ver
o horário livre e marcar, outra pessoa pode marcar. É por isso que a tela
precisa tratar `horario_ocupado` mesmo tendo acabado de mostrar aquele horário
como disponível — e há um teste nomeando exatamente isso.

---

## 5. Componentes do NOT

```
┌──────────────────────────────────────────────┐
│ NOT                                           │
│                                               │
│  consumidor(fila notificacao-enviar)          │
│         │                                     │
│         ▼                                     │
│  daEvento()  traduz o evento em aviso         │
│         │                                     │
│         ▼                                     │
│  registrar()  INSERT com UNIQUE (id_evento)   │
│         │        └── 23505 = já notifiquei    │
│         ▼                                     │
│  enviar()  adaptador do provedor              │
└──────────────────────────────────────────────┘
```

O `UNIQUE (id_evento)` é o componente mais importante deste contêiner, mesmo
não sendo código: a entrega da fila é **ao menos uma vez**, e sem ele o cliente
recebe o mesmo lembrete duas vezes.

---

## 6. Decisões visíveis no diagrama

| O que o diagrama mostra | ADR |
|---|---|
| Oito contêineres de aplicação em vez de um | ADR-001 |
| A constraint desenhada **no banco**, não no serviço | ADR-002 |
| Oito bancos lógicos, um usuário cada | ADR-003 |
| Seta do AGD para SNS, e não para NOT | ADR-004 |
| `expediente_espelho` dentro do AGD | ADR-005 |
| Só o AGD com 2 a 4 tarefas | Documento 05, §3.1 |
