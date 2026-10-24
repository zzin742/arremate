-- Aplicado nos bancos de AUTH, CAT, LEI e MID — os quatro produtores de
-- evento (MER §4.10). Mesma estrutura nos quatro; muda só o que vai em
-- `agregado` e `tipo_evento`.
CREATE TABLE outbox (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agregado       VARCHAR(30) NOT NULL,
  id_agregado    UUID        NOT NULL,
  tipo_evento    VARCHAR(40) NOT NULL,
  payload        JSONB       NOT NULL,
  -- marca o início da pendência; é esta a idade que o painel acompanha,
  -- e não a métrica da DLQ, que conta a partir da transferência
  pendente_desde TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  publicado_em   TIMESTAMPTZ
);

CREATE INDEX outbox_pendentes ON outbox (criado_em) WHERE publicado_em IS NULL;
