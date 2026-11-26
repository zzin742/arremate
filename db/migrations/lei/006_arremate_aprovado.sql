-- Aprovação do arremate na reverificação (RF-004b, RF-023).
--
-- Até aqui o `arremate` só sabia dizer que foi ANULADO. O caminho feliz
-- — reverificação aprovada — não tinha registro nenhum, e por isso o
-- único `leilao_liquidar` publicado era o da anulação. O CAU nunca
-- recebia a ordem de abater a caução do arrematante, porque ela não era
-- emitida por ninguém.
--
-- `aprovado_em` é o que torna a aprovação idempotente: aprovar duas
-- vezes não publica duas liquidações, e o CAU não recebe duas ordens de
-- abatimento para a mesma caução.

ALTER TABLE arremate ADD COLUMN aprovado_em TIMESTAMPTZ;

-- Aprovado e anulado são estados opostos sobre o MESMO arremate, e nada
-- impediria os dois carimbos coexistirem. A regra fica no banco e não só
-- na aplicação porque a anulação e a aprovação entram por rotas
-- diferentes: deixar a exclusão mútua para o código seria confiar em
-- dois caminhos lembrarem da mesma coisa.
ALTER TABLE arremate ADD CONSTRAINT arremate_nao_aprovado_e_anulado
  CHECK (aprovado_em IS NULL OR anulado_em IS NULL);

COMMENT ON COLUMN arremate.aprovado_em IS
  'Reverificacao aprovada. Dispara leilao_liquidar com abatimento do arrematante (RF-023). Exclusivo com anulado_em';
