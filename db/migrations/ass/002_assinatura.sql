-- Planos e assinaturas.
--
-- O plano é da barbearia; a assinatura é do cliente naquela barbearia. A
-- mesma pessoa pode assinar em duas casas diferentes, e são assinaturas
-- independentes.

CREATE TYPE modo_cobranca AS ENUM ('offline', 'online');

CREATE TYPE status_assinatura AS ENUM (
  'aguardando_pagamento', 'ativa', 'vence_em_breve', 'vencida', 'inativa', 'cancelada'
);

CREATE TYPE estado_uso AS ENUM ('reservado', 'consumido');

CREATE TABLE plano (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_barbearia    UUID NOT NULL,
  nome            VARCHAR(120) NOT NULL,
  preco_centavos  INTEGER NOT NULL CHECK (preco_centavos >= 0),
  desconto_pct    SMALLINT CHECK (desconto_pct BETWEEN 0 AND 100),
  modo_cobranca   modo_cobranca NOT NULL DEFAULT 'offline',
  instrucoes_pagamento VARCHAR(400),
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX plano_por_barbearia ON plano (id_barbearia) WHERE ativo;

-- Quais serviços o plano cobre, e quantas vezes por ciclo.
CREATE TABLE plano_servico (
  id_plano        UUID NOT NULL REFERENCES plano (id) ON DELETE CASCADE,
  id_servico      UUID NOT NULL,             -- serviço no CAT
  -- NULL = sem limite. Zero não é permitido: um plano que cobre zero
  -- vezes é o mesmo que não cobrir, e deixar passar criaria plano que
  -- parece incluir o serviço e nunca deixa usar.
  limite_por_ciclo INTEGER CHECK (limite_por_ciclo IS NULL OR limite_por_ciclo > 0),
  PRIMARY KEY (id_plano, id_servico)
);

CREATE TABLE assinatura (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_cliente   UUID NOT NULL,                -- conta no AUTH
  id_plano     UUID NOT NULL REFERENCES plano (id),
  id_barbearia UUID NOT NULL,
  status       status_assinatura NOT NULL DEFAULT 'aguardando_pagamento',
  comeca_em    DATE NOT NULL,
  termina_em   DATE NOT NULL,
  criada_em    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ciclo_termina_depois CHECK (termina_em > comeca_em)
);
CREATE INDEX assinatura_por_cliente ON assinatura (id_cliente, id_barbearia);

-- Uma assinatura VIVA por cliente e barbearia. Índice único parcial, e
-- não constraint na aplicação: assinar duas vezes ao mesmo tempo é
-- exatamente o que acontece quando o cliente clica duas vezes.
CREATE UNIQUE INDEX assinatura_viva_unica ON assinatura (id_cliente, id_barbearia)
  WHERE status IN ('aguardando_pagamento', 'ativa', 'vence_em_breve', 'vencida');

-- Consumo do plano dentro do ciclo.
CREATE TABLE uso_assinatura (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_assinatura  UUID NOT NULL REFERENCES assinatura (id) ON DELETE CASCADE,
  id_servico     UUID NOT NULL,
  -- Agendamento no AGD. O UNIQUE é o que torna o consumo idempotente:
  -- o evento de agendamento pode chegar duas vezes, e descontar duas do
  -- plano seria cobrar o cliente por um corte que ele fez uma vez.
  id_agendamento UUID NOT NULL UNIQUE,
  estado         estado_uso NOT NULL DEFAULT 'reservado',
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX uso_por_assinatura ON uso_assinatura (id_assinatura);

COMMENT ON COLUMN uso_assinatura.id_agendamento IS
  'UNIQUE: a entrega de evento e ao menos uma vez, e descontar duas vezes do plano cobraria o cliente por um corte so';
