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
    # O lcov traz caminho relativo ao diretório do serviço. Prefixar com
    # o caminho REAL dele (services/auth, packages/shared) faz duas
    # coisas que um rótulo inventado não fazia:
    #
    #  - distingue `src/db.js` de auth e de lei, que é o motivo original;
    #  - deixa o caminho do arquivo compartilhado resolver sozinho. O
    #    lcov do auth cita `../../packages/shared/src/banco.js`; com o
    #    prefixo certo isso normaliza para o mesmo caminho que o lcov do
    #    lei produz, e o agregador conta o arquivo UMA vez.
    relativo="${dir#$RAIZ/}"
    sed "s|^SF:|SF:${relativo}|" "$SAIDA/$nome.lcov" > "$SAIDA/$nome.ajustado.lcov"
    echo "    $nome"
  fi
done

echo "==> medindo o worker de mídia (Python)"
if [ -x "$RAIZ/services/mid/.venv/bin/python" ]; then
  PY="$RAIZ/services/mid/.venv/bin/python"
  "$PY" -m pip install -q coverage >/dev/null 2>&1 || true
  (cd "$RAIZ/services/mid" \
    && "$PY" -m coverage run -m pytest -q >/dev/null 2>&1 \
    && "$PY" -m coverage lcov -o "$SAIDA/mid.bruto.lcov" >/dev/null 2>&1) || true

  if [ -s "$SAIDA/mid.bruto.lcov" ]; then
    # O mesmo prefixo dos serviços Node, pelo mesmo motivo. O coverage
    # emite `src/conversao.py`, relativo ao diretório do worker; sem o
    # prefixo esse caminho nunca bate com `services/mid/src/conversao.py`
    # da varredura, e o arquivo era contado DUAS vezes — uma como medido
    # e outra como "sem teste", com todas as linhas zeradas.
    sed "s|^SF:|SF:services/mid/|" "$SAIDA/mid.bruto.lcov" > "$SAIDA/mid.ajustado.lcov"
    echo "    mid"
  fi
fi

echo "==> agregando"
python3 "$RAIZ/db/testes/agregar_cobertura.py" "$SAIDA" "$RAIZ" "$META"
