-- CAU — caução e eventos de pagamento

CREATE TABLE caucao (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_leilao   UUID          NOT NULL,
  id_empresa  UUID          NOT NULL,
  valor       NUMERIC(14,2) NOT NULL CHECK (valor > 0),
  status      VARCHAR(20)   NOT NULL DEFAULT 'pendente'
              CHECK (status IN ('pendente','confirmada','recusada',
                                'abatida','devolvida')),
  criado_em   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (id_leilao, id_empresa)
);

CREATE TABLE evento_pagamento (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_caucao         UUID         NOT NULL REFERENCES caucao (id),
  id_evento_externo VARCHAR(120) NOT NULL,
  tipo              VARCHAR(40)  NOT NULL,
  payload           JSONB        NOT NULL,
  recebido_em       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- RF-021: webhook repetido não pode ser processado duas vezes. A chave é
-- o id do EVENTO, não o da transação — uma transação gera vários eventos.
ALTER TABLE evento_pagamento ADD CONSTRAINT evento_pagamento_unico
  UNIQUE (id_evento_externo);
