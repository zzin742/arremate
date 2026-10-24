-- O MVP de dezembro abre leilão sobre DESCRIÇÃO LIVRE do equipamento.
--
-- A entidade EQUIPAMENTO pertence ao CAT (MER §7), e o CAT só entra na
-- Sprint 9. Colocar um CRUD de equipamento no LEI agora criaria violação
-- de propriedade de dados que depois teria de ser desfeita.
ALTER TABLE leilao ALTER COLUMN id_equipamento DROP NOT NULL;
ALTER TABLE leilao ADD COLUMN descricao_equipamento VARCHAR(200);

-- um dos dois tem de existir: referência ao catálogo ou descrição livre
ALTER TABLE leilao ADD CONSTRAINT leilao_tem_equipamento
  CHECK (id_equipamento IS NOT NULL OR descricao_equipamento IS NOT NULL);

-- vendedor não pode dar lance no próprio leilão (RN02) — a checagem é na
-- aplicação, dentro da trava, porque depende de comparar duas colunas de
-- tabelas diferentes
CREATE INDEX lance_por_leilao_sequencia ON lance (id_leilao, sequencia DESC);

COMMENT ON INDEX leilao_ativo_unico IS
  'Vale só quando id_equipamento nao e nulo: no MVP, com descricao livre, dois leiloes da mesma maquina nao sao detectaveis';
