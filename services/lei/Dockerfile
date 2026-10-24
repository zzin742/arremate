# Imagem dos serviços Node. A mesma receita vale para auth, hab, lei e cau
# — muda só o diretório copiado, passado em SERVICO.
FROM node:22-alpine
WORKDIR /app
ARG SERVICO

# Camada de dependências separada: o npm ci só roda de novo quando um
# package.json muda, não a cada alteração de código.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/${SERVICO}/package.json services/${SERVICO}/
RUN npm ci --omit=dev --workspace @arremate/${SERVICO} --include-workspace-root

COPY packages/shared/ packages/shared/
COPY services/${SERVICO}/src/ services/${SERVICO}/src/

# ARG só existe durante o build. Sem promover para ENV, o ${SERVICO} do
# CMD é expandido como vazio em tempo de execução e o Node procura
# /app/services/src/index.js — que não existe.
ENV SERVICO=${SERVICO}
ENV NODE_ENV=production

# Não roda como root: se o processo for comprometido, o alcance é menor
USER node

EXPOSE 3000
CMD ["sh", "-c", "node services/$SERVICO/src/index.js"]
