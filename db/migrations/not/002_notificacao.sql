-- NOT — registro das notificações (RF-027, RF-028, RF-029)

CREATE TABLE notificacao (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_empresa       UUID         NOT NULL,
  tipo             VARCHAR(40)  NOT NULL,
  titulo           VARCHAR(120) NOT NULL,
  corpo            VARCHAR(400) NOT NULL,
  -- id do evento que originou. A entrega e ao menos uma vez (ADR-007),
  -- entao o UNIQUE e o que impede avisar a mesma pessoa duas vezes.
  id_evento_origem UUID         NOT NULL UNIQUE,
  lida_em          TIMESTAMPTZ,
  criado_em        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX notificacao_por_empresa ON notificacao (id_empresa, criado_em DESC);
CREATE INDEX notificacao_nao_lidas   ON notificacao (id_empresa) WHERE lida_em IS NULL;
