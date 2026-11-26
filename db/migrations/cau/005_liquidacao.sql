-- Liquidação do leilão: abatimento e devolução (RF-023, T-025).
--
-- O RF-023 é explícito em dizer que a devolução é **solicitada ao
-- provedor e confirmada por webhook, não apenas marcada no banco**. Isso
-- cria um estado que a máquina de transições não tinha: a caução já foi
-- mandada devolver, mas ainda está `confirmada`, porque só o webhook
-- `pagamento.devolvido` a move para `devolvida`.
--
-- Sem registrar esse instante, reprocessar o evento de liquidação — que
-- a entrega SQS faz ao menos uma vez — chamaria `provedor.devolver()` de
-- novo para a mesma cobrança. `devolucao_solicitada_em` é a marca que
-- torna o consumo idempotente sem inventar um sexto status.

ALTER TABLE caucao ADD COLUMN devolucao_solicitada_em TIMESTAMPTZ;

-- A liquidação varre as cauções de um leilão; sem este índice a varredura
-- é um seq scan a cada encerramento.
CREATE INDEX caucao_por_leilao ON caucao (id_leilao);

COMMENT ON COLUMN caucao.devolucao_solicitada_em IS
  'Momento em que a devolucao foi pedida ao provedor. O status so vai para devolvida quando o webhook confirmar (RF-023)';

-- Decisão de liquidação recebida do LEI.
--
-- A tabela existe por uma razão só: idempotência do consumo. A entrega
-- do SQS é ao menos uma vez, e liquidar duas vezes significaria abater
-- de novo e pedir devolução de novo. A chave primária pelo id do evento
-- é o que recusa a segunda tentativa — a mesma estratégia que
-- `evento_pagamento` usa para o webhook.
CREATE TABLE liquidacao (
  id_evento   VARCHAR(120) PRIMARY KEY,
  id_leilao   UUID         NOT NULL,
  anulado     BOOLEAN      NOT NULL,
  -- NULL quando todas são devolvidas (arremate anulado): não há de quem
  -- abater, e guardar o arrematante aqui sugeriria que houve abatimento
  abater_de   UUID,
  abatidas    INT          NOT NULL DEFAULT 0,
  devolvidas  INT          NOT NULL DEFAULT 0,
  recebido_em TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE liquidacao IS
  'Decisoes de liquidacao ja aplicadas. A PK pelo id do evento torna o consumo idempotente (entrega SQS e ao menos uma vez)';
