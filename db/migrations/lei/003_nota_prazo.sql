-- Nota de implementação, registrada no banco para não se perder.
--
-- A revalidação do prazo DENTRO da trava precisa usar clock_timestamp(),
-- não now(). O now() é transaction_timestamp(): congela no início da
-- transação. Como o lance espera na fila do SELECT ... FOR UPDATE, uma
-- requisição pode ficar parada segundos ali e seria avaliada com o relógio
-- de ANTES da espera — aceitando lance depois do encerramento.
--
--   ERRADO:  WHERE encerra_em > now()
--   CERTO:   WHERE encerra_em > clock_timestamp()
--
-- Adotado da proposta de MVP recebida em 24/10 (docs/recebidos/).
COMMENT ON COLUMN leilao.encerra_em IS
  'Comparar sempre com clock_timestamp(), nunca com now(): now() congela no inicio da transacao e o lance espera na fila do FOR UPDATE';
