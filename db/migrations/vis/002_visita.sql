-- VIS — agenda sem sobreposição (RF-024, RF-025)

CREATE TABLE visita (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  id_equipamento UUID        NOT NULL,   -- vive no banco do CAT
  id_empresa     UUID        NOT NULL,   -- vive no banco do AUTH
  periodo        TSTZRANGE   NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'agendada'
                 CHECK (status IN ('agendada', 'cancelada', 'realizada')),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A regra do RF-025 é do BANCO, não da aplicação: duas visitas agendadas
-- para o mesmo equipamento não podem ter períodos que se sobrepõem.
-- O WHERE é o que permite cancelar e reagendar no mesmo horário.
ALTER TABLE visita ADD CONSTRAINT visita_sem_sobreposicao
  EXCLUDE USING gist (id_equipamento WITH =, periodo WITH &&)
  WHERE (status = 'agendada');
