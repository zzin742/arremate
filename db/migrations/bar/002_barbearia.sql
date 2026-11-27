-- Barbearia: perfil público, horário de funcionamento e quem trabalha nela.

CREATE TYPE papel_membro AS ENUM ('dono', 'socio', 'funcionario');

CREATE TABLE cidade (
  id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome   VARCHAR(120) NOT NULL,
  uf     CHAR(2)      NOT NULL,
  UNIQUE (nome, uf)
);

CREATE TABLE barbearia (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_dono        UUID NOT NULL,              -- conta no AUTH
  nome           VARCHAR(140) NOT NULL,
  apelido_url    VARCHAR(80)  NOT NULL,
  id_cidade      UUID REFERENCES cidade (id),
  endereco       VARCHAR(200),
  whatsapp       VARCHAR(20),
  -- Identificador do lugar no Google, usado para puxar as avaliações
  -- públicas. É a integração externa exigida pelo termo.
  id_google_place VARCHAR(120),
  latitude       NUMERIC(10, 7),
  longitude      NUMERIC(10, 7),
  ativa          BOOLEAN NOT NULL DEFAULT TRUE,
  criada_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX barbearia_apelido_unico ON barbearia (lower(apelido_url));
CREATE INDEX barbearia_por_cidade ON barbearia (id_cidade) WHERE ativa;

-- Horário de funcionamento da casa, por dia da semana.
CREATE TABLE horario_barbearia (
  id_barbearia  UUID NOT NULL REFERENCES barbearia (id) ON DELETE CASCADE,
  dia_da_semana SMALLINT NOT NULL CHECK (dia_da_semana BETWEEN 0 AND 6),
  abre_em       TIME NOT NULL,
  fecha_em      TIME NOT NULL,
  PRIMARY KEY (id_barbearia, dia_da_semana, abre_em),
  CONSTRAINT fecha_depois_de_abrir CHECK (fecha_em > abre_em)
);

-- Fechamento pontual: feriado, reforma, férias.
CREATE TABLE fechamento (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_barbearia UUID NOT NULL REFERENCES barbearia (id) ON DELETE CASCADE,
  dia          DATE NOT NULL,
  motivo       VARCHAR(120),
  UNIQUE (id_barbearia, dia)
);

-- Quem trabalha na barbearia, e com qual papel.
CREATE TABLE membro (
  id_barbearia UUID NOT NULL REFERENCES barbearia (id) ON DELETE CASCADE,
  id_conta     UUID NOT NULL,                -- conta no AUTH
  papel        papel_membro NOT NULL,
  aceito_em    TIMESTAMPTZ,                  -- NULL = convite pendente
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id_barbearia, id_conta)
);

-- Uma barbearia tem exatamente um dono. O índice único parcial é o que
-- impede dois: deixar isso para a aplicação permitiria a corrida entre
-- transferir a posse e aceitar um convite.
CREATE UNIQUE INDEX barbearia_um_dono ON membro (id_barbearia)
  WHERE papel = 'dono';

COMMENT ON INDEX barbearia_um_dono IS
  'Uma barbearia tem um dono so. Indice unico parcial: a aplicacao sozinha teria corrida';
