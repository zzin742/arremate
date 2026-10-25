-- CAT — equipamento e mídia (RF-006 a RF-010)
--
-- A propriedade de EQUIPAMENTO é do CAT (MER §7). O LEI guarda só o
-- id_equipamento e pergunta aqui quando precisa do resto.

CREATE TABLE equipamento (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_empresa         UUID         NOT NULL,   -- vive no banco do AUTH
  nome               VARCHAR(150) NOT NULL,
  categoria          VARCHAR(60)  NOT NULL,
  ano                SMALLINT     CHECK (ano IS NULL OR ano BETWEEN 1900 AND 2100),
  estado_conservacao VARCHAR(30)  NOT NULL
                     CHECK (estado_conservacao IN ('novo','seminovo','usado','sucata')),
  localizacao        VARCHAR(120) NOT NULL,
  ficha_tecnica      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  criado_em          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- RF-007: busca combinando categoria, faixa de preço, estado e
-- localização. O índice cobre os três filtros exatos; a faixa de preço
-- é do leilão, que vive no LEI.
CREATE INDEX equipamento_busca
  ON equipamento (categoria, estado_conservacao, localizacao);

CREATE INDEX equipamento_por_empresa ON equipamento (id_empresa, criado_em DESC);

CREATE TABLE midia (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_equipamento   UUID         NOT NULL REFERENCES equipamento (id) ON DELETE CASCADE,
  tipo             VARCHAR(10)  NOT NULL CHECK (tipo IN ('foto','video')),
  -- chave em originais/; o MID lê daqui e grava em processados/.
  -- A separação por prefixo é o que impede o derivado disparar nova
  -- conversão, porque a notificação do S3 filtra só originais/ (DFD).
  chave_original   VARCHAR(255) NOT NULL UNIQUE,
  chave_processada VARCHAR(255),
  status           VARCHAR(20)  NOT NULL DEFAULT 'aguardando_upload'
                   CHECK (status IN ('aguardando_upload','na_fila','processando','pronta','erro')),
  tentativas       SMALLINT     NOT NULL DEFAULT 0,
  erro             VARCHAR(200),
  criado_em        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX midia_por_equipamento ON midia (id_equipamento, criado_em);

-- aquisição atômica do trabalho pelo MID (DFD, decisão 6)
CREATE INDEX midia_a_converter ON midia (criado_em)
  WHERE status IN ('na_fila','erro');
