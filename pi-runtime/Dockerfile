FROM node:24-bookworm-slim

# 安装系统工具：bwrap（沙盒核心）、python3（沙盒内 Python 环境）、ripgrep（pi 依赖）
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    ca-certificates \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# 全局安装 pi coding agent
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 安装 pi-mcp-adapter 插件（pi 调用 MCP 服务的唯一社区适配器）
# 等效于交互式环境下执行 `pi install npm:pi-mcp-adapter`
# 原理：npm pack 下载 tarball → 解压到 pi extensions 目录，pi 启动时自动加载
RUN mkdir -p /root/.pi/agent/extensions && \
    cd /tmp && \
    npm pack pi-mcp-adapter && \
    mkdir -p /root/.pi/agent/extensions/pi-mcp-adapter && \
    tar -xzf pi-mcp-adapter-*.tgz \
        -C /root/.pi/agent/extensions/pi-mcp-adapter \
        --strip-components=1 && \
    rm /tmp/pi-mcp-adapter-*.tgz

WORKDIR /app

# 先安装 worker 依赖（含 devDependencies 用于编译 TypeScript）
COPY package.json .
RUN npm install

# 安装自定义 MCP 服务器依赖
COPY extensions/mcp-servers/package.json ./extensions/mcp-servers/
RUN cd extensions/mcp-servers && npm install --omit=dev

# 复制源码并编译 TypeScript
COPY tsconfig.json .
COPY src ./src
RUN npm run build

# 复制扩展目录（bwrap extension、mcp-servers、mcp.json）
COPY extensions ./extensions
COPY config/mcp.json ./config/mcp.json

# 将 MCP 配置和 bwrap 扩展注册到 pi 默认路径
RUN mkdir -p /root/.pi/agent/extensions && \
    cp config/mcp.json /root/.pi/agent/mcp.json && \
    cp -r extensions/bwrap /root/.pi/agent/extensions/bwrap

# 清理 devDependencies（编译完成后不再需要）
RUN npm prune --omit=dev

# 沙盒临时目录
RUN mkdir -p /tmp/pi-sandbox

ENV NODE_ENV=production
ENV SANDBOX_ROOT=/tmp/pi-sandbox

CMD ["node", "dist/worker.js"]
