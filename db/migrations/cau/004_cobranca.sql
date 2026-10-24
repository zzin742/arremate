-- Referência da cobrança no provedor, necessária para a reconciliação
-- (RF-022): sem ela não há como perguntar "e esta, como ficou?".
ALTER TABLE caucao ADD COLUMN id_cobranca_externa VARCHAR(120);
ALTER TABLE caucao ADD COLUMN provedor VARCHAR(40) NOT NULL DEFAULT 'sandbox';
ALTER TABLE caucao ADD COLUMN atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX caucao_cobranca_unica
  ON caucao (provedor, id_cobranca_externa)
  WHERE id_cobranca_externa IS NOT NULL;

-- o reconciliador busca por aqui
CREATE INDEX caucao_pendentes ON caucao (criado_em) WHERE status = 'pendente';

COMMENT ON COLUMN caucao.status IS
  'pendente -> confirmada|recusada; confirmada -> abatida|devolvida. Transicao invalida e recusada pela aplicacao sob trava da linha';
