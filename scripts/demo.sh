#!/usr/bin/env bash
#
# Sobe tudo o que a demonstração da banca precisa, com um comando (T-024).
#
# O motivo de existir: a demo depende de Postgres, migrations, dois
# serviços Node e o Vite, cada um num terminal. Lembrar da ordem na frente
# da banca é onde a apresentação morre — e o modo de falhar é silencioso,
# porque a tela abre e só quebra no primeiro clique.
#
# Este script sobe na ordem, ESPERA cada peça responder antes da próxima,
# e derruba tudo o que subiu quando receber Ctrl+C.
#
#   bash scripts/demo.sh           sobe e deixa rodando
#   bash scripts/demo.sh --semear  sobe e já cria empresa e leilão abertos
#
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"
LOGS="$RAIZ/.demo-logs"
mkdir -p "$LOGS"

AUTH=http://localhost:3001
LEI=http://localhost:3002
HAB=http://localhost:3003
WEB=http://localhost:5173

azul()  { printf '\033[34m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
erro()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

pids=()
encerrar() {
  echo
  azul '==> encerrando'
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  verde 'serviços parados. O Postgres continua de pé (npm run db:down para derrubar).'
}
trap encerrar EXIT INT TERM

# Espera uma URL responder. Sem isto o passo seguinte corre contra um
# serviço que ainda está abrindo conexão com o banco, e falha por timing
# — o pior tipo de erro para depurar ao vivo.
esperar() {
  local url="$1" nome="$2" tentativas="${3:-40}"
  for ((i = 1; i <= tentativas; i++)); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      verde "    $nome no ar"
      return 0
    fi
    sleep 0.5
  done
  erro "    $nome NÃO respondeu em $url"
  erro "    veja $LOGS/$nome.log"
  return 1
}

azul '==> 1/4 Postgres, Redis e LocalStack'
if ! docker info >/dev/null 2>&1; then
  erro 'Docker não está rodando. Abra o Docker Desktop e repita.'
  exit 1
fi
npm run db:up >/dev/null
verde '    contêineres saudáveis'

azul '==> 2/4 migrations'
node db/migrar.js | tail -1

azul '==> 3/4 serviços'
# O HAB entra porque o lance exige habilitação (RF-004, RF-012): sem ele
# a tela loga e para no primeiro clique com "Habilitação ausente".
for s in auth lei hab; do
  npm start --workspace "@arremate/$s" >"$LOGS/$s.log" 2>&1 &
  pids+=($!)
done
esperar "$AUTH/saude" auth
esperar "$LEI/saude" lei
esperar "$HAB/saude" hab

azul '==> 4/4 interface'
npm run web >"$LOGS/web.log" 2>&1 &
pids+=($!)
esperar "$WEB" web 60

if [[ "${1:-}" == '--semear' ]]; then
  azul '==> semeando exemplos'
  # Em Node, e não em curl: o semeador precisa calcular CNPJ válido,
  # guardar token entre chamadas e escrever em dois bancos. A versão
  # anterior era uma linha de curl com CNPJ fixo, e morria em 409 na
  # segunda vez — com `set -e`, derrubando a demo inteira junto.
  node scripts/semear-demo.mjs || erro '    semeadura falhou; os serviços seguem no ar'
fi

echo
verde "Interface:  $WEB"
echo  "AUTH:       $AUTH/saude"
echo  "LEI:        $LEI/saude"
echo  "Grafana:    http://localhost:3030"
echo  "Logs:       $LOGS/"
echo
azul 'Ctrl+C derruba os serviços.'
wait
