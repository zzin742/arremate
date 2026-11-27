-- Agendamento: o núcleo do MVP.
--
-- A regra que o sistema inteiro existe para garantir cabe numa linha:
-- **nunca dois atendimentos vivos na mesma cadeira ao mesmo tempo.**
--
-- Ela é imposta pelo BANCO, com `EXCLUDE USING gist`, e não pela
-- aplicação. A diferença aparece sob concorrência: dois clientes tocando
-- "agendar" no mesmo segundo, para o mesmo barbeiro e o mesmo horário,
-- passam os dois por qualquer verificação feita antes do INSERT — entre
-- ler "está livre" e gravar existe uma janela, e sob carga ela é
-- alcançada. A constraint não tem janela: o segundo INSERT é recusado
-- pelo Postgres, sempre.
--
-- `btree_gist` (em _comum/000) é pré-requisito: sem ele o Postgres
-- recusa a constraint, porque `uuid` não tem classe de operador gist
-- padrão.
--
--   ERROR: data type uuid has no default operator class for access method "gist"

CREATE TYPE status_agendamento AS ENUM (
  'agendado', 'concluido', 'faltou', 'cancelado_pelo_cliente', 'cancelado_pela_barbearia'
);

CREATE TYPE origem_agendamento AS ENUM ('site', 'painel');

CREATE TABLE agendamento (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Ids de outros serviços entram como UUID sem FK: a barbearia vive no
  -- banco do BAR e o barbeiro no do CAT, e nenhum serviço enxerga o
  -- banco do outro. A integridade entre serviços é garantida por evento,
  -- não por chave estrangeira — é o preço da separação, e está no ADR.
  id_barbearia    UUID NOT NULL,
  id_barbeiro     UUID NOT NULL,
  id_servico      UUID NOT NULL,

  -- Cliente cadastrado OU encaixe anotado no balcão, nunca nenhum dos
  -- dois: a barbearia precisa registrar quem entrou sem agendar, e esse
  -- atendimento ocupa a cadeira igual.
  id_cliente      UUID,
  nome_encaixe    VARCHAR(120),
  whatsapp_encaixe VARCHAR(20),

  dia             DATE NOT NULL,
  comeca_em       TIME NOT NULL,
  termina_em      TIME NOT NULL,

  status          status_agendamento NOT NULL DEFAULT 'agendado',
  origem          origem_agendamento NOT NULL DEFAULT 'site',

  valor_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  -- Atendimento consumido por assinatura não é cobrado na hora; o ASS
  -- controla o ciclo. Aqui fica só a marca, para o relatório do dono.
  por_assinatura  BOOLEAN NOT NULL DEFAULT FALSE,
  id_assinatura   UUID,

  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT termina_depois_de_comecar CHECK (termina_em > comeca_em),
  CONSTRAINT tem_cliente_ou_encaixe
    CHECK (id_cliente IS NOT NULL OR nome_encaixe IS NOT NULL),

  -- A REGRA. O `WHERE` é o que a torna correta: um atendimento cancelado
  -- libera o horário, e sem o filtro ele continuaria bloqueando a cadeira
  -- para sempre. Faltou (`faltou`) também libera — a cadeira esteve vaga.
  CONSTRAINT cadeira_ocupada_uma_vez EXCLUDE USING gist (
    id_barbeiro WITH =,
    tsrange((dia + comeca_em), (dia + termina_em), '[)') WITH &&
  ) WHERE (status IN ('agendado', 'concluido'))
);

-- A agenda do dia é a consulta mais frequente do painel.
CREATE INDEX agendamento_por_barbearia_dia ON agendamento (id_barbearia, dia);
-- "Meus agendamentos" do cliente.
CREATE INDEX agendamento_por_cliente ON agendamento (id_cliente, dia DESC)
  WHERE id_cliente IS NOT NULL;

COMMENT ON CONSTRAINT cadeira_ocupada_uma_vez ON agendamento IS
  'Nunca dois atendimentos vivos na mesma cadeira ao mesmo tempo. Imposta pelo banco: verificacao na aplicacao tem janela entre ler e gravar';

-- Espelho do que o CAT publica sobre a agenda de trabalho do barbeiro.
--
-- O AGD precisa saber, DENTRO da transação do agendamento, se o barbeiro
-- trabalha naquele dia e naquela faixa. Consultar o CAT por HTTP ali
-- dentro seguraria a transação pelo tempo de uma chamada de rede. O
-- espelho é consulta local; a fonte de verdade continua sendo o CAT.
CREATE TABLE expediente_espelho (
  id_barbeiro   UUID NOT NULL,
  dia_da_semana SMALLINT NOT NULL CHECK (dia_da_semana BETWEEN 0 AND 6),
  comeca_em     TIME NOT NULL,
  termina_em    TIME NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (id_barbeiro, dia_da_semana, comeca_em),
  CONSTRAINT expediente_termina_depois CHECK (termina_em > comeca_em)
);

COMMENT ON TABLE expediente_espelho IS
  'Copia de leitura do expediente publicado pelo CAT. Fonte de verdade e o CAT';

-- Bloqueios pontuais: folga, almoço, compromisso. Também espelhado,
-- porque entra na mesma decisão.
CREATE TABLE bloqueio_espelho (
  id            UUID PRIMARY KEY,
  id_barbeiro   UUID NOT NULL,
  comeca_em     TIMESTAMPTZ NOT NULL,
  termina_em    TIMESTAMPTZ NOT NULL,
  motivo        VARCHAR(120),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT bloqueio_termina_depois CHECK (termina_em > comeca_em)
);
CREATE INDEX bloqueio_por_barbeiro ON bloqueio_espelho (id_barbeiro, comeca_em);
