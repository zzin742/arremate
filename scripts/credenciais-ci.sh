#!/usr/bin/env bash
# Leva a credencial do Learner Lab para os secrets do GitHub.
#
# O AWS Academy não dá chave permanente nem deixa criar role IAM — logo,
# nada de OIDC, que é como um projeto normal autenticaria o GitHub
# Actions na AWS. O que ele dá é uma credencial de sessão que expira com
# o lab (cerca de 4 h) e muda a cada vez que o lab sobe.
#
# Então o deploy automático depende de alguém reabrir o lab e rodar isto.
# Rodar uma vez por sessão é o preço; o que o CD evita é o resto —
# construir sete imagens, empurrar para o ECR, trocar as tasks e
# conferir se responderam.
#
#   bash scripts/credenciais-ci.sh
#
# Depois disso, Actions > Deploy > Run workflow, ou qualquer push na main.
set -euo pipefail

PERFIL="${AWS_PROFILE:-arremate-lab}"

for cmd in aws gh; do
  command -v "$cmd" > /dev/null || { echo "falta o comando: $cmd"; exit 1; }
done

echo "==> conferindo o perfil $PERFIL"
if ! AWS_PROFILE="$PERFIL" AWS_REGION=us-east-1 aws sts get-caller-identity > /dev/null 2>&1; then
  cat <<'FIM'
credencial inválida ou expirada.

Abra o Learner Lab, clique em "AWS Details" > "AWS CLI" e cole o bloco em
~/.aws/credentials sob o perfil [arremate-lab]. São três linhas:
aws_access_key_id, aws_secret_access_key e aws_session_token — a terceira
é a que costuma ficar para trás, e sem ela a autenticação falha com
"InvalidClientTokenId", que não diz nada sobre o que faltou.
FIM
  exit 1
fi

conta=$(AWS_PROFILE="$PERFIL" AWS_REGION=us-east-1 aws sts get-caller-identity \
          --query Account --output text)
echo "    conta $conta"

# `aws configure get` lê o arquivo sem imprimir nada em lugar nenhum; as
# variáveis não passam por linha de comando, para não irem parar no
# histórico do shell.
chave=$(aws --profile "$PERFIL" configure get aws_access_key_id)
segredo=$(aws --profile "$PERFIL" configure get aws_secret_access_key)
sessao=$(aws --profile "$PERFIL" configure get aws_session_token)

if [ -z "$sessao" ]; then
  echo "o perfil não tem aws_session_token — credencial do Learner Lab sempre tem"
  exit 1
fi

echo "==> gravando os secrets do repositório"
printf '%s' "$chave"   | gh secret set AWS_ACCESS_KEY_ID
printf '%s' "$segredo" | gh secret set AWS_SECRET_ACCESS_KEY
printf '%s' "$sessao"  | gh secret set AWS_SESSION_TOKEN

echo
echo "pronto. a credencial vale enquanto o lab estiver aberto."
echo "deploy: gh workflow run Deploy"
