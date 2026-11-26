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
for s in auth lei; do
  npm start --workspace "@arremate/$s" >"$LOGS/$s.log" 2>&1 &
  pids+=($!)
done
esperar "$AUTH/saude" auth
esperar "$LEI/saude" lei

azul '==> 4/4 interface'
npm run web >"$LOGS/web.log" 2>&1 &
pids+=($!)
esperar "$WEB" web 60

if [[ "${1:-}" == '--semear' ]]; then
  azul '==> semeando empresa e leilão'
  # O e-mail leva o epoch para a semeadura poder ser repetida sem
  # esbarrar no UNIQUE do cadastro.
  email="demo-$(date +%s)@arremate.local"
  senha='demo12345'

  curl -fsS -X POST "$AUTH/empresas" -H 'Content-Type: application/json' \
    -d "{\"cnpj\":\"11222333000181\",\"razaoSocial\":\"Metalúrgica Demo\",\"email\":\"$email\",\"senha\":\"$senha\"}" \
    >/dev/null
  verde "    empresa criada: $email / $senha"
  echo
  verde '    Entre na interface com esse e-mail e abra um leilão pela tela.'
  echo '    O lance exige habilitação e caução (RF-012), que são do HAB e do CAU —'
  echo '    por isso a demo de concorrência roda pelo teste, não pelo navegador:'
  echo
  echo '      npm test --workspace @arremate/lei'
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
