-- Conta e sessão.
--
-- O AUTH responde "quem é você". O papel dentro de uma barbearia é outra
-- pergunta, e vive no BAR: a mesma pessoa é dona de uma barbearia e
-- cliente de outra, e juntar as duas coisas aqui obrigaria o AUTH a
-- conhecer barbearia.

CREATE TABLE conta (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome          VARCHAR(120) NOT NULL,
  email         VARCHAR(160) NOT NULL,
  -- hash bcrypt; a senha em claro nunca chega ao banco
  senha_hash    VARCHAR(80)  NOT NULL,
  whatsapp      VARCHAR(20),
  criado_em     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Citext seria mais limpo, mas exige extensão a mais: o índice único
  -- sobre lower(email) resolve e não adiciona dependência.
  CONSTRAINT email_tem_arroba CHECK (position('@' IN email) > 1)
);

CREATE UNIQUE INDEX conta_email_unico ON conta (lower(email));

-- Bloqueio de conta pela plataforma, com motivo privado.
CREATE TABLE bloqueio_conta (
  id_conta    UUID PRIMARY KEY REFERENCES conta (id) ON DELETE CASCADE,
  motivo      VARCHAR(200) NOT NULL,
  bloqueado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE bloqueio_conta IS
  'Motivo e privado: aparece para a plataforma, nunca para o bloqueado';
