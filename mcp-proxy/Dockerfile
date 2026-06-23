FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV NODE_ENV=production

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD curl -f http://127.0.0.1:${MCP_PROXY_PORT:-8080}/health || exit 1

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${MCP_PROXY_PORT:-8080} --no-access-log"]
