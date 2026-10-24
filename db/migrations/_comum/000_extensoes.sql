-- Aplicado em TODOS os bancos lógicos, antes das migrations do serviço.
--
-- btree_gist é pré-requisito do EXCLUDE em vis/002. Sem ele o PostgreSQL
-- recusa a constraint, porque uuid não tem classe de operador gist padrão:
--   ERROR: data type uuid has no default operator class for access method "gist"
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
