FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY tsconfig.json .
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

ENV NODE_ENV=production

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD curl -f http://127.0.0.1:${MCP_PROXY_PORT:-8080}/health || exit 1

CMD ["node", "dist/index.js"]
