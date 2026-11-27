# Documento de Requisitos

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Versão:** 1.0 — 27/11/2026

---

## 1. Objetivo

Relacionar os requisitos funcionais (RF) e não funcionais (RNF) do Na Régua,
derivados do problema descrito no
[Documento de Solicitação do Sistema](01-solicitacao-do-sistema.md).

Cada requisito traz um **critério de aceite verificável**. Requisito sem
critério não é requisito: é intenção.

> **Prioridade não é cronograma.** Prioridade **Alta** diz que o requisito é
> essencial ao produto, não que ele entra no primeiro semestre. Quem define o
> que entra em cada semestre é o
> [Planejamento de Sprints](08-planejamento-sprints-tarefas.md), que trabalha
> com a capacidade real do grupo.

---

## 2. Microsserviços

| Sigla | Serviço | Responsabilidade |
|---|---|---|
| `auth` | Identidade | conta, sessão, token |
| `bar` | Barbearia | perfil, horário de funcionamento, membros |
| `cat` | Catálogo | serviços, barbeiros, expediente, bloqueios |
| `agd` | **Agendamento** | marcar, cancelar, concluir, falta |
| `ass` | Assinatura | planos e ciclo de uso |
| `ava` | Avaliação | nota e comentário do atendimento |
| `pag` | Pagamento | cobrança da plataforma à barbearia |
| `not` | Notificação | avisos, sempre por evento |

---

## 3. Requisitos Funcionais

| ID | Descrição | Critério de aceite | Prior. | Serviço |
|---|---|---|---|---|
| RF-001 | Cadastro de conta com nome, e-mail e senha | Após o cadastro, a pessoa autentica e recebe token válido. E-mail repetido é recusado com código próprio, sem criar conta pela metade | Alta | AUTH |
| RF-002 | Autenticação com token de sessão | Token ausente, inválido ou expirado resulta em HTTP 401 em qualquer rota protegida | Alta | AUTH |
| RF-003 | Senha armazenada apenas como hash | Nenhuma resposta da API e nenhum payload de evento contém a senha ou o hash | Alta | AUTH |
| RF-004 | Bloqueio de conta pela plataforma | Conta bloqueada não autentica; **o motivo não aparece** para quem foi bloqueado | Média | AUTH |
| RF-005 | Cadastro de barbearia com perfil público | Quem cria vira dono. O perfil é acessível por apelido de URL, sem exigir sessão | Alta | BAR |
| RF-006 | Uma barbearia tem exatamente um dono | Tentar registrar um segundo dono é recusado **pelo banco**, mesmo sob requisições simultâneas | Alta | BAR |
| RF-007 | Horário de funcionamento por dia da semana | Horário com fim anterior ao início é recusado | Alta | BAR |
| RF-008 | Fechamento pontual: feriado, férias, reforma | Dia fechado não oferece horário livre | Média | BAR |
| RF-009 | Convite de membro com papel | Membro só conta como equipe depois de **aceitar**; convite pendente não aparece | Média | BAR |
| RF-010 | Cadastro de serviço com preço e duração | Preço em centavos inteiros. Duração entre 1 e 480 minutos | Alta | CAT |
| RF-011 | Serviço inativo sai da vitrine sem sumir do histórico | Serviço desativado não aparece na lista pública; agendamentos antigos continuam íntegros | Média | CAT |
| RF-012 | Cadastro de barbeiro, com ou sem conta de acesso | Barbeiro sem login existe na agenda e pode ser agendado | Alta | CAT |
| RF-013 | Barbeiro atende um subconjunto de serviços | Barbeiro marcado como "faz todos" atende qualquer serviço sem configuração extra | Média | CAT |
| RF-014 | Expediente semanal do barbeiro | Agendamento fora do expediente é recusado com motivo legível | Alta | CAT |
| RF-015 | Bloqueio pontual na agenda do barbeiro | Dois bloqueios sobrepostos no mesmo barbeiro são recusados **pelo banco** | Alta | CAT |
| RF-016 | Publicação de `expediente_mudou` | Alterar expediente ou bloqueio grava o evento **na mesma transação** da alteração | Alta | CAT |
| RF-017 | Consulta de horários livres | A lista desconta o que já está marcado e os bloqueios. Não exige sessão | Alta | AGD |
| **RF-018** | **Agendamento com garantia de exclusividade da cadeira** | **Com N pedidos simultâneos para o mesmo barbeiro e horário, exatamente um é aceito. Os demais recebem recusa de negócio, não erro interno** | **Alta** | **AGD** |
| RF-019 | Horário encostado é permitido | Um atendimento que termina às 10h30 não bloqueia o que começa às 10h30 | Alta | AGD |
| RF-020 | Agendamento no passado é recusado | A verificação usa o relógio do **banco**, não o da aplicação | Alta | AGD |
| RF-021 | Encaixe anotado no balcão | Atendimento sem conta de cliente ocupa a cadeira igual, e exige nome | Média | AGD |
| RF-022 | Cancelamento pelo cliente ou pela barbearia | O status registra **quem** cancelou. O cliente só cancela o próprio | Alta | AGD |
| RF-023 | Cancelar libera a cadeira | Após o cancelamento, o horário volta a ser agendável | Alta | AGD |
| RF-024 | Conclusão do atendimento | Atendimento concluído **não** libera a cadeira e dá direito a avaliar | Alta | AGD |
| RF-025 | Registro de falta | Falta libera a cadeira, porque ela esteve vaga de verdade | Média | AGD |
| RF-026 | Agenda do dia para o painel | Ordenada por horário, exige sessão | Alta | AGD |
| RF-027 | Plano de assinatura da barbearia | Plano define serviços cobertos e limite por ciclo | Média | ASS |
| RF-028 | Uma assinatura viva por cliente e barbearia | Segunda assinatura viva é recusada **pelo banco** | Média | ASS |
| RF-029 | Consumo do plano no agendamento | O mesmo atendimento **não** desconta duas vezes do plano, mesmo recebendo o evento repetido | Alta | ASS |
| RF-030 | Avaliação do atendimento concluído | Uma avaliação por atendimento, e só de quem foi atendido | Média | AVA |
| RF-031 | Avaliações públicas do Google | A barbearia com `id_google_place` exibe as avaliações públicas do Google junto às próprias | Média | AVA |
| RF-032 | Notificação ao cliente e à barbearia | A notificação sai por **evento**, nunca por chamada direta. O mesmo evento entregue duas vezes notifica uma vez | Alta | NOT |
| RF-033 | Pagamento da barbearia à plataforma | Webhook repetido do provedor não lança o pagamento duas vezes | Média | PAG |

---

## 4. Requisitos Não Funcionais

### 4.1 Desempenho

| ID | Descrição | Medição | Meta |
|---|---|---|---|
| RNF-001 | Tempo de resposta do agendamento | Latência P95 na borda da API | < 400 ms, com 20 clientes simultâneos por 5 min |
| RNF-002 | Capacidade de agendamentos concorrentes no mesmo barbeiro | RPS sustentado, sem agendamento confirmado perdido | > 30 RPS; recusa por regra de negócio **não** conta como falha |
| RNF-003 | Consulta de horários livres | Latência P95 | < 300 ms |

### 4.2 Confiabilidade e integridade

| ID | Descrição | Meta |
|---|---|---|
| RNF-004 | A regra de exclusividade da cadeira é imposta **pelo banco**, não pela aplicação | Constraint `EXCLUDE USING gist`; a aplicação não consulta disponibilidade antes de inserir |
| RNF-005 | Evento publicado na mesma transação da mudança de estado | Padrão outbox; nenhuma publicação após o COMMIT |
| RNF-006 | Entrega de evento é **ao menos uma vez**; todo consumidor é idempotente | Chave única por evento em cada consumidor |
| RNF-007 | Nenhum serviço lê o banco de outro | Um usuário PostgreSQL por serviço, sem permissão nos demais |
| RNF-008 | Falha de notificação não impede agendamento | O `not` só consome evento; não é chamado por HTTP |

### 4.3 Segurança

| ID | Descrição | Meta |
|---|---|---|
| RNF-009 | Senha com hash de custo configurável | bcrypt, custo mínimo 10 |
| RNF-010 | Credencial nunca viaja em evento | Nenhum payload de outbox contém senha, hash ou token |
| RNF-011 | Resposta de login não revela quais e-mails existem | Senha errada e e-mail inexistente produzem a **mesma** resposta e o mesmo tempo |
| RNF-012 | Banco e cache sem acesso público | `publicly_accessible = false`; security group aceita só do grupo da aplicação |
| RNF-013 | Serviço não roda como root no contêiner | `USER node` na imagem |

### 4.4 Qualidade e operação

| ID | Descrição | Meta |
|---|---|---|
| RNF-014 | Cobertura de testes automatizados | **≥ 60%** — linhas cobertas somadas ÷ linhas executáveis somadas, de todos os serviços. Não é média das porcentagens, que mascara serviço sem teste. Arquivo sem teste entra no denominador |
| RNF-015 | O pipeline bloqueia merge com teste falhando ou cobertura abaixo da meta | PR com CI vermelho não é mergeável |
| RNF-016 | Provisionamento por Terraform | Nenhum recurso criado pelo console |
| RNF-017 | Métricas em Prometheus, painel em Grafana | Painel **provisionado por arquivo**, não configurado pelo console |
| RNF-018 | Métrica de saúde da outbox | Idade da pendência mais antiga exposta como métrica — é ela que denuncia publicador parado |
| RNF-019 | Ambiente local completo por Docker Compose | Contingência da banca: sobe sem internet |

---

## 5. Glossário

| Termo | Significado |
|---|---|
| **Cadeira** | O par barbeiro + intervalo de tempo. É o recurso disputado |
| **Encaixe** | Atendimento anotado no balcão, sem conta de cliente |
| **Expediente** | Faixa semanal em que o barbeiro atende |
| **Bloqueio** | Período pontual indisponível: almoço, folga, compromisso |
| **Ciclo** | Período de validade de uma assinatura |
| **Outbox** | Tabela onde o evento é gravado na mesma transação da mudança de estado |
