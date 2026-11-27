-- Pagamento da barbearia à plataforma.
--
-- É o modelo do Na Régua: a plataforma cobra a barbearia, não o cliente
-- final. O que o cliente paga pelo corte acontece no balcão e está fora
-- do sistema — registrar isso seria afirmar um fluxo financeiro que não
-- existe.

CREATE TABLE pagamento_plataforma (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_barbearia    UUID NOT NULL,
  pago_em         DATE NOT NULL,
  valor_centavos  INTEGER NOT NULL CHECK (valor_centavos > 0),
  observacao      VARCHAR(400),
  -- Id do evento no provedor. UNIQUE: webhook repetido não lança o
  -- pagamento duas vezes — a entrega do provedor é ao menos uma vez.
  id_evento_externo VARCHAR(120) UNIQUE,
  registrado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pagamento_por_barbearia ON pagamento_plataforma (id_barbearia, pago_em DESC);

COMMENT ON COLUMN pagamento_plataforma.id_evento_externo IS
  'UNIQUE: webhook repetido nao lanca o pagamento duas vezes';
