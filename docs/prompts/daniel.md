Você vai implementar a minha frente de um Projeto Experimental da faculdade (ADS, UniFAAT). O projeto é o **Na Régua**, um marketplace de barbearias: o cliente acha a barbearia, escolhe o serviço e o barbeiro, e marca o horário.

Meu nome é Daniel. Minha frente é **"Dados e catálogo"** — os serviços `bar` e `cat`.

## Antes de escrever qualquer código

Clone o repositório e leia, nesta ordem:

1. `README.md` — o problema e a arquitetura
2. `docs/divisao-do-trabalho.md` — a minha frente está detalhada lá, com as rotas
3. `docs/entregaveis/07-registro-decisoes-arquitetonicas-adr.md` — **leia inteiro**, principalmente a ADR-003 (um banco por serviço) e a ADR-005 (espelho do expediente)
4. `db/migrations/bar/002_barbearia.sql` e `db/migrations/cat/002_catalogo.sql` — o meu schema já existe
5. `services/auth/src/contas.js` e `services/agd/src/agendamentos.js` — são a referência de estilo. **Siga o mesmo padrão**: módulo de domínio separado do `index.js` do Express, erro de negócio com código próprio, evento na mesma transação.

Suba o ambiente antes de começar:

```bash
npm install
npm run db:up
npm run migrar
npm test          # tem de passar antes de eu mexer em nada
```

## O que eu tenho de entregar

### `services/bar` — a barbearia

```
POST   /barbearias                    cria (quem cria vira dono)
GET    /barbearias/:apelido           perfil público, sem exigir sessão
PUT    /barbearias/:id/horarios       horário de funcionamento
POST   /barbearias/:id/fechamentos    feriado, férias, reforma
POST   /barbearias/:id/membros        convida alguém
POST   /membros/:id/aceitar           aceita o convite
GET    /barbearias/:id/membros        quem trabalha aqui
```

Regras que o banco já impõe e que eu preciso traduzir em resposta de negócio:

- **uma barbearia tem um dono só** — índice único parcial `barbearia_um_dono`. Violação vem como `unique_violation` (código `23505`) e tem de virar HTTP 409 com código próprio, nunca 500.
- apelido de URL é único, sem diferenciar maiúsculas.
- convite só vale depois de aceito: `aceito_em` nulo significa pendente, e membro pendente não aparece como quem trabalha na barbearia.

### `services/cat` — o catálogo

```
POST   /servicos                      cria serviço
GET    /barbearias/:id/servicos       vitrine (sem sessão)
PUT    /servicos/:id                  edita
POST   /barbeiros                     cria barbeiro
GET    /barbearias/:id/barbeiros      equipe
PUT    /barbeiros/:id/expediente      define o expediente semanal
POST   /barbeiros/:id/bloqueios       bloqueia um período
DELETE /bloqueios/:id                 desbloqueia
```

Regras:

- **bloqueios do mesmo barbeiro não se sobrepõem** — constraint `bloqueio_sem_sobreposicao`, que é um `EXCLUDE USING gist`. A violação vem como `exclusion_violation` (código `23P01`) e tem de virar 409 com motivo legível.
- serviço inativo não aparece na vitrine, mas continua existindo para o histórico.
- preço em **centavos, inteiro**. Nunca float: dinheiro em ponto flutuante acumula erro de arredondamento, e aqui isso vira diferença no caixa do dono.
- barbeiro com `faz_todos = true` atende qualquer serviço sem precisar preencher `barbeiro_servico`.

### A parte mais importante da minha frente: publicar o expediente

Quando o expediente ou um bloqueio mudar, o `cat` precisa publicar o evento `expediente_mudou` na tabela `outbox`, **na mesma transação** da alteração.

É desse evento que o serviço de agendamento (`agd`, que já está pronto) alimenta o espelho local dele. Está explicado na ADR-005, e eu preciso entender o porquê antes de implementar: o `agd` consulta o expediente **dentro da transação do agendamento**, e uma chamada HTTP ali dentro seguraria a transação pelo tempo da rede.

O formato do payload tem de bater com o que o `agd` espera. Olhe as tabelas `expediente_espelho` e `bloqueio_espelho` em `db/migrations/agd/002_agendamento.sql` para saber quais campos mandar.

## Como eu quero que você trabalhe

- **Teste primeiro, ou junto.** Todo teste tem de falhar se a regra for removida. Teste que passa com a regra desligada não prova nada. Olhe `services/agd/tests/agendamentos.test.js` para ver o padrão.
- **Comentário explica o porquê, não o quê.** `// incrementa i` não serve. `// o índice único parcial existe porque deixar isso para a aplicação permitiria a corrida entre transferir a posse e aceitar um convite` serve.
- **Não mexa em `services/auth`, `services/agd`, `infra/` nem em `db/migrations/agd/`.** São de outra frente. Se eu precisar de algo de lá, eu peço.
- **Em português**, igual ao resto do projeto — nomes de função, variável, rota e mensagem de erro.
- Rode `npm run lint` e `npm test` antes de cada commit. A cobertura global não pode cair abaixo de 60%.

## O que eu preciso saber defender na banca

A arguição é individual, então me ajude a entender, não só a ter o código pronto. Quando terminar, me explique com as suas palavras:

1. Por que o `agd` tem uma cópia do expediente em vez de perguntar ao `cat`? O que se perde com isso?
2. Por que um banco lógico por serviço, se é tudo o mesmo PostgreSQL?
3. Por que a regra de "um dono só" é um índice no banco e não um `if` no código?

Comece lendo os arquivos que listei e me diga o que entendeu do projeto antes de escrever a primeira linha.
