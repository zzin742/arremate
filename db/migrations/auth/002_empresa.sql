-- AUTH — empresa (RF-001, RF-002)

CREATE TABLE empresa (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cnpj         CHAR(14)     NOT NULL UNIQUE,   -- só dígitos, normalizado na aplicação
  razao_social VARCHAR(150) NOT NULL,
  email        VARCHAR(150) NOT NULL UNIQUE,   -- minúsculo, normalizado na aplicação
  senha_hash   VARCHAR(255) NOT NULL,          -- bcrypt; nunca a senha em claro
  criado_em    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
