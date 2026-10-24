-- LEI — leilão, lance e arremate

CREATE TABLE leilao (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_equipamento  UUID           NOT NULL,   -- vive no banco do CAT
  id_empresa      UUID           NOT NULL,   -- vendedor; vive no AUTH
  lance_inicial   NUMERIC(14,2)  NOT NULL CHECK (lance_inicial > 0),
  incremento_min  NUMERIC(14,2)  NOT NULL CHECK (incremento_min > 0),
  encerra_em      TIMESTAMPTZ    NOT NULL,
  status          VARCHAR(20)    NOT NULL DEFAULT 'agendado'
                  CHECK (status IN ('agendado','aberto','encerrado','deserto',
                                    'cancelado','arremate_anulado')),
  criado_em       TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- RF-011: um equipamento não pode estar em dois leilões ativos ao mesmo
-- tempo. Índice único PARCIAL — encerrado e cancelado não contam, senão
-- o equipamento nunca mais poderia ser releiloado.
CREATE UNIQUE INDEX leilao_ativo_unico ON leilao (id_equipamento)
  WHERE status IN ('agendado', 'aberto');

CREATE TABLE lance (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_leilao   UUID          NOT NULL REFERENCES leilao (id),
  id_empresa  UUID          NOT NULL,
  valor       NUMERIC(14,2) NOT NULL CHECK (valor > 0),
  sequencia   BIGINT        NOT NULL,
  criado_em   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- RF-014(c): ordem total dentro do leilão. Dois lances não podem ocupar
-- a mesma posição na sequência.
ALTER TABLE lance ADD CONSTRAINT lance_sequencia_unica
  UNIQUE (id_leilao, sequencia);

-- par necessário para a FK composta do arremate
ALTER TABLE lance ADD CONSTRAINT lance_id_leilao_unico UNIQUE (id, id_leilao);

CREATE TABLE arremate (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_leilao        UUID         NOT NULL UNIQUE REFERENCES leilao (id),
  id_lance         UUID         NOT NULL,
  anulado_em       TIMESTAMPTZ,
  motivo_anulacao  VARCHAR(40),
  criado_em        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- FK composta: garante que o lance vencedor é DAQUELE leilão, e não de outro
ALTER TABLE arremate ADD CONSTRAINT arremate_lance_do_mesmo_leilao
  FOREIGN KEY (id_lance, id_leilao) REFERENCES lance (id, id_leilao);
