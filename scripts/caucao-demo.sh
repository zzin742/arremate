#!/usr/bin/env bash
#
# Semeia a caução confirmada de uma empresa num leilão, para a demonstração.
#
# No fluxo real a caução nasce de uma cobrança no provedor, é confirmada
# por webhook e chega ao LEI como evento (`caucao_mudou`), que mantém um
# espelho local para conferir dentro da trava do leilão. Numa demo isso
# exigiria o CAU no ar e um provedor respondendo.
#
# Esta linha escreve direto no espelho do LEI. É SEMEADURA: o que vem
# depois — o lance conferir a caução sob a trava — é o caminho real.
#
#   bash scripts/caucao-demo.sh <id-do-leilao> <id-da-empresa>
#
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "uso: bash scripts/caucao-demo.sh <id-do-leilao> <id-da-empresa>" >&2
  exit 1
fi

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker compose exec -T postgres psql -q -U arremate -d arremate_lei -c \
  "INSERT INTO caucao_ativa (id_leilao, id_empresa, id_caucao)
   VALUES ('$1', '$2', gen_random_uuid())
   ON CONFLICT (id_leilao, id_empresa) DO UPDATE SET atualizado_em = now()"

printf '\033[32mcaução ativa para a empresa %s no leilão %s\033[0m\n' "$2" "$1"
