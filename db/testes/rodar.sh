#!/usr/bin/env bash
# Aplica as migrations pendentes e prova as constraints críticas.
#
# Cada banco tem uma tabela `schema_migrations`: a migration só roda se
# ainda não estiver registrada, e o registro acontece na MESMA transação
# da migration. Rodar duas vezes é seguro; rodar pela metade não deixa o
# banco num estado que a próxima execução não saiba resolver.
set -euo pipefail

CT="${ARREMATE_PG_CONTAINER:-arremate-postgres-1}"
psql_em() { docker exec -i "$CT" psql -U arremate -v ON_ERROR_STOP=1 -q -At -d "$1"; }

aplicar() {           # $1 = banco, $2 = caminho da migration
  local db="$1" arq="$2" nome
  nome="$(basename "$(dirname "$arq")")/$(basename "$arq")"

  psql_em "$db" <<'EOSQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  nome        TEXT PRIMARY KEY,
  aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
EOSQL

  if [ "$(echo "SELECT count(*) FROM schema_migrations WHERE nome='$nome';" | psql_em "$db")" != "0" ]; then
    return 0
  fi

  { echo "BEGIN;"; cat "$arq";
    echo "INSERT INTO schema_migrations (nome) VALUES ('$nome');"; echo "COMMIT;"; } \
    | psql_em "$db"
  echo "    $db <- $nome"
}

echo "==> aplicando migrations pendentes"
for banco in auth hab cat mid lei cau vis not; do
  db="arremate_${banco}"
  aplicar "$db" db/migrations/_comum/000_extensoes.sql
  case "$banco" in
    auth|cat|lei|mid) aplicar "$db" db/migrations/_comum/001_outbox.sql ;;
  esac
  for m in db/migrations/"$banco"/*.sql; do
    [ -e "$m" ] || continue
    aplicar "$db" "$m"
  done
done

echo "==> provando as constraints"
docker exec -i "$CT" psql -U arremate -v ON_ERROR_STOP=1 -q -d postgres \
  < db/testes/constraints.test.sql
