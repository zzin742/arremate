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
LIMITE_POR_ARQUIVO="${LIMITE_POR_ARQUIVO:-240}"   # segundos por arquivo de teste

rm -rf "$SAIDA" && mkdir -p "$SAIDA"

# Mata o processo e seus descendentes.
#
# O node roda cada arquivo de teste num processo filho. `kill` no pai
# deixa o filho vivo e órfão, ainda segurando conexão com o banco.
matar_arvore() {
  local alvo="$1" filho
  for filho in $(pgrep -P "$alvo" 2>/dev/null); do
    matar_arvore "$filho"
  done
  kill -9 "$alvo" 2>/dev/null || true
}

echo "==> medindo serviços Node"
for dir in "$RAIZ"/services/*/ "$RAIZ"/packages/*/ "$RAIZ"/web/; do
  nome="$(basename "$dir")"
  [ -f "$dir/package.json" ] || continue
  [ -d "$dir/src" ] || continue

  # UMA invocação por arquivo de teste, e não uma por serviço.
  #
  # Os arquivos de um serviço dividem um banco, e o TRUNCATE do
  # `beforeEach` de um zera a mesa do outro — por isso o script `test` de
  # cada pacote usa `--test-concurrency=1`. Só que `--test-concurrency=1`
  # junto de `--experimental-test-coverage` **trava** no Node 26.7: os
  # dois arquivos do CAT rodam em 8 s sem a serialização, 15 s cada um
  # sozinho, e passam de 11 minutos sem terminar quando se pede as duas
  # coisas ao mesmo tempo.
  #
  # Um arquivo por invocação resolve os dois lados: não há concorrência
  # dentro da execução para travar, e também não há dois arquivos
  # disputando o banco. O agregador junta os relatórios depois.
  #
  # `--test-timeout` porque o `|| true` engole falha E travamento, e de
  # fora os dois são indistinguíveis: a medição fica rodando para sempre
  # sem imprimir nada. Com o limite, teste pendurado morre e aparece
  # como teste que falhou, que é o que ele é.
  i=0
  for teste in "$dir"tests/*.test.js "$dir"src/*.test.js; do
    [ -e "$teste" ] || continue
    i=$((i + 1))
    # `exec` faz o node SUBSTITUIR a subshell, e não ser filho dela.
    # Sem isso, `$!` é o PID da subshell: o cão de guarda matava a
    # casca e o node seguia vivo, adotado pelo init. Foi assim que doze
    # processos de teste ficaram rodando por até duas horas, deixando a
    # máquina lenta o bastante para a medição seguinte também estourar
    # o limite — um travamento gerando o próximo.
    (cd "$dir" && exec node --test --test-timeout=60000 \
        --experimental-test-coverage \
        --test-reporter=lcov \
        --test-reporter-destination="$SAIDA/$nome.$i.lcov" \
        "${teste#$dir}" \
        >/dev/null 2>&1) &
    medindo=$!

    # Cão de guarda. O `--test-timeout` do Node cobre o teste, não o
    # processo: já houve invocação parada 19 minutos em `kevent`,
    # esperando um evento que não vinha, sem estourar timeout nenhum.
    # Travamento é o pior desfecho — não dá erro, não dá log, e de fora
    # é idêntico a "ainda trabalhando".
    #
    # `timeout(1)` resolveria, mas não existe no macOS, onde o projeto
    # também roda.
    ( sleep "$LIMITE_POR_ARQUIVO"; matar_arvore "$medindo" ) &
    cao=$!
    # sem o disown, encerrar o cão imprime um aviso de job control a
    # cada arquivo e enterra o relatório em ruído
    disown "$cao" 2>/dev/null || true

    if wait "$medindo" 2>/dev/null; then
      :                            # teste que falha é problema do job de testes
    else
      estado=$?
      [ "$estado" -ge 128 ] && echo "    !! ${teste#$RAIZ/} morreu no limite de ${LIMITE_POR_ARQUIVO}s"
    fi
    kill "$cao" 2>/dev/null || true
    # o node roda cada arquivo num processo filho (--test-isolation=process);
    # matar só o pai deixaria esse filho órfão e vivo
    matar_arvore "$medindo"
  done

  # junta os relatórios do serviço num só, para o passo seguinte
  cat "$SAIDA/$nome".*.lcov > "$SAIDA/$nome.lcov" 2>/dev/null || true
  rm -f "$SAIDA/$nome".[0-9]*.lcov

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
