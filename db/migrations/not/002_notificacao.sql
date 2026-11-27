-- Notificação ao cliente e à barbearia.
--
-- O NOT só consome evento: nunca é chamado por HTTP por outro serviço.
-- É o que garante que notificação jamais bloqueie o agendamento — se o
-- provedor de e-mail estiver fora, o corte continua marcado.

CREATE TYPE estado_envio AS ENUM ('pendente', 'enviado', 'falhou');

CREATE TABLE notificacao (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tipo        VARCHAR(60)  NOT NULL,
  destinatario VARCHAR(200) NOT NULL,
  referencia  VARCHAR(120),
  -- Id do evento que originou. UNIQUE: a entrega é ao menos uma vez, e
  -- sem isto o cliente receberia o mesmo lembrete duas vezes.
  id_evento   UUID NOT NULL UNIQUE,
  estado      estado_envio NOT NULL DEFAULT 'pendente',
  detalhe     VARCHAR(400),
  criada_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  enviada_em  TIMESTAMPTZ
);
CREATE INDEX notificacao_pendente ON notificacao (criada_em) WHERE estado = 'pendente';

COMMENT ON COLUMN notificacao.id_evento IS
  'UNIQUE: entrega e ao menos uma vez, e sem isto o cliente receberia o mesmo lembrete duas vezes';
