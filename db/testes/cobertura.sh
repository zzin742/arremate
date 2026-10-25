#!/usr/bin/env bash
# Mede a cobertura global pela regra do RNF-020.
#
# A regra é específica e não é a que a maioria das ferramentas mostra por
# padrão: **soma das linhas cobertas ÷ soma das linhas executáveis**, de
# todos os serviços juntos. Média das porcentagens mascara serviço sem
# teste — um serviço de 10 linhas com 100% compensaria um de 500 com 0%.
#
# Arquivos sem teste nenhum entram no denominador. É por isso que o
# agregador varre o código-fonte, e não só o que apareceu no relatório.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SAIDA="${RAIZ}/coverage"
META="${META_COBERTURA:-60}"

rm -rf "$SAIDA" && mkdir -p "$SAIDA"

echo "==> medindo serviços Node"
for dir in "$RAIZ"/services/*/ "$RAIZ"/packages/*/; do
  nome="$(basename "$dir")"
  [ -f "$dir/package.json" ] || continue
  [ -d "$dir/src" ] || continue

  (cd "$dir" && node --test \
      --experimental-test-coverage \
      --test-reporter=lcov \
      --test-reporter-destination="$SAIDA/$nome.lcov" \
      >/dev/null 2>&1) || true     # teste que falha é problema do job de testes

  if [ -s "$SAIDA/$nome.lcov" ]; then
    # o lcov traz caminho relativo ao serviço; prefixa para o agregador
    # distinguir src/db.js de auth e de lei
    sed "s|^SF:|SF:services-ou-pacote/$nome/|" "$SAIDA/$nome.lcov" > "$SAIDA/$nome.ajustado.lcov"
    echo "    $nome"
  fi
done

echo "==> medindo o worker de mídia (Python)"
if [ -x "$RAIZ/services/mid/.venv/bin/python" ]; then
  PY="$RAIZ/services/mid/.venv/bin/python"
  "$PY" -m pip install -q coverage >/dev/null 2>&1 || true
  (cd "$RAIZ/services/mid" \
    && "$PY" -m coverage run -m pytest -q >/dev/null 2>&1 \
    && "$PY" -m coverage lcov -o "$SAIDA/mid.ajustado.lcov" >/dev/null 2>&1) || true
  [ -s "$SAIDA/mid.ajustado.lcov" ] && echo "    mid"
fi

echo "==> agregando"
python3 "$RAIZ/db/testes/agregar_cobertura.py" "$SAIDA" "$RAIZ" "$META"
