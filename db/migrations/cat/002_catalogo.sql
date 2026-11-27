-- Catálogo: o que a barbearia vende e quem atende.

-- O que o serviço inclui, para a vitrine do cliente.
CREATE TYPE etiqueta_servico AS ENUM (
  'corte', 'barba', 'sobrancelha', 'lavagem', 'pezinho',
  'hidratacao', 'pigmentacao', 'luzes', 'limpeza_pele', 'infantil'
);

CREATE TABLE servico (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_barbearia   UUID NOT NULL,              -- barbearia no BAR
  nome           VARCHAR(120) NOT NULL,
  descricao      VARCHAR(400),
  -- Em centavos, inteiro: dinheiro em ponto flutuante acumula erro de
  -- arredondamento, e aqui ele vira diferença no caixa do dono.
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  -- "a partir de": corte com preço variável por cabelo. Muda o rótulo na
  -- vitrine, não o valor cobrado.
  a_partir_de    BOOLEAN NOT NULL DEFAULT FALSE,
  duracao_min    SMALLINT NOT NULL CHECK (duracao_min > 0 AND duracao_min <= 480),
  foto_url       VARCHAR(400),
  ordem          INTEGER NOT NULL DEFAULT 0,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX servico_por_barbearia ON servico (id_barbearia, ordem) WHERE ativo;

CREATE TABLE servico_inclui (
  id_servico UUID NOT NULL REFERENCES servico (id) ON DELETE CASCADE,
  etiqueta   etiqueta_servico NOT NULL,
  PRIMARY KEY (id_servico, etiqueta)
);

CREATE TABLE barbeiro (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_barbearia  UUID NOT NULL,
  id_conta      UUID,                        -- NULL: barbeiro sem login
  nome          VARCHAR(120) NOT NULL,
  foto_url      VARCHAR(400),
  -- Comissão padrão, em pontos percentuais. A exceção por serviço fica
  -- em `comissao_por_servico`; aqui é o que vale quando não há exceção.
  comissao_pct  SMALLINT NOT NULL DEFAULT 50 CHECK (comissao_pct BETWEEN 0 AND 100),
  -- Atalho do caso comum: barbeiro que faz tudo. Quando verdadeiro,
  -- `barbeiro_servico` nem precisa ser preenchido.
  faz_todos     BOOLEAN NOT NULL DEFAULT TRUE,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX barbeiro_por_barbearia ON barbeiro (id_barbearia) WHERE ativo;

-- Nem todo barbeiro faz todo serviço.
CREATE TABLE barbeiro_servico (
  id_barbeiro UUID NOT NULL REFERENCES barbeiro (id) ON DELETE CASCADE,
  id_servico  UUID NOT NULL REFERENCES servico (id) ON DELETE CASCADE,
  PRIMARY KEY (id_barbeiro, id_servico)
);

-- Comissão diferente da padrão, para um serviço específico.
CREATE TABLE comissao_por_servico (
  id_barbeiro UUID NOT NULL REFERENCES barbeiro (id) ON DELETE CASCADE,
  id_servico  UUID NOT NULL REFERENCES servico (id) ON DELETE CASCADE,
  pct         SMALLINT NOT NULL CHECK (pct BETWEEN 0 AND 100),
  PRIMARY KEY (id_barbeiro, id_servico)
);

-- Expediente semanal.
CREATE TABLE expediente (
  id_barbeiro   UUID NOT NULL REFERENCES barbeiro (id) ON DELETE CASCADE,
  dia_da_semana SMALLINT NOT NULL CHECK (dia_da_semana BETWEEN 0 AND 6),
  comeca_em     TIME NOT NULL,
  termina_em    TIME NOT NULL,
  PRIMARY KEY (id_barbeiro, dia_da_semana, comeca_em),
  CONSTRAINT expediente_termina_depois CHECK (termina_em > comeca_em)
);

-- Bloqueio pontual na agenda do barbeiro.
CREATE TABLE bloqueio (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_barbeiro UUID NOT NULL REFERENCES barbeiro (id) ON DELETE CASCADE,
  comeca_em   TIMESTAMPTZ NOT NULL,
  termina_em  TIMESTAMPTZ NOT NULL,
  motivo      VARCHAR(120),

  CONSTRAINT bloqueio_termina_depois CHECK (termina_em > comeca_em),
  -- Dois bloqueios sobrepostos no mesmo barbeiro não são erro grave, mas
  -- sujam a conta de horário livre. A mesma `EXCLUDE` do agendamento
  -- resolve, e aqui sem filtro: bloqueio não tem status.
  CONSTRAINT bloqueio_sem_sobreposicao EXCLUDE USING gist (
    id_barbeiro WITH =,
    tstzrange(comeca_em, termina_em, '[)') WITH &&
  )
);
