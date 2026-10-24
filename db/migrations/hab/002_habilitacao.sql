-- HAB — habilitação da empresa (RF-003, RF-004, RF-005)

CREATE TABLE habilitacao (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_empresa        UUID        NOT NULL,     -- vive no banco do AUTH
  cnpj              CHAR(14)    NOT NULL,
  situacao          VARCHAR(20) NOT NULL
                    CHECK (situacao IN ('pendente', 'aprovada', 'recusada')),
  detalhe           VARCHAR(200),
  -- id do evento conta_criada que originou esta verificação.
  -- A entrega é ao menos uma vez (ADR-007), então o mesmo evento pode
  -- chegar duas vezes: o UNIQUE é o que torna o processamento idempotente.
  id_evento_origem  UUID        NOT NULL UNIQUE,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- o varredor do RF-005 busca por aqui
CREATE INDEX habilitacao_pendentes ON habilitacao (criado_em) WHERE situacao = 'pendente';
CREATE INDEX habilitacao_por_empresa ON habilitacao (id_empresa, criado_em DESC);
