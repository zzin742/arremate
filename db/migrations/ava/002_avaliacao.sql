-- Avaliação do atendimento.
--
-- Só quem foi atendido avalia, e uma vez por atendimento. As duas regras
-- estão no banco: a segunda como UNIQUE, a primeira garantida porque a
-- avaliação nasce de um agendamento concluído — o AVA recebe o evento e
-- não aceita avaliação sem ele.

CREATE TABLE avaliacao (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- UNIQUE: uma avaliação por atendimento. Sem isso o cliente pode
  -- avaliar de novo e empurrar a média da barbearia para onde quiser.
  id_agendamento UUID NOT NULL UNIQUE,
  id_cliente     UUID NOT NULL,
  id_barbearia   UUID NOT NULL,
  id_barbeiro    UUID,
  nota           SMALLINT NOT NULL CHECK (nota BETWEEN 1 AND 5),
  texto          VARCHAR(1000),
  criada_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX avaliacao_por_barbearia ON avaliacao (id_barbearia, criada_em DESC);

-- Atendimentos concluídos que ainda podem ser avaliados.
--
-- Espelho alimentado por evento do AGD. Existe para o AVA conseguir
-- recusar avaliação de atendimento que não houve, sem consultar o AGD
-- por rede a cada tentativa.
CREATE TABLE atendimento_espelho (
  id_agendamento UUID PRIMARY KEY,
  id_cliente     UUID NOT NULL,
  id_barbearia   UUID NOT NULL,
  id_barbeiro    UUID,
  concluido_em   TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE atendimento_espelho IS
  'Copia de leitura dos atendimentos concluidos. Fonte de verdade e o AGD';
