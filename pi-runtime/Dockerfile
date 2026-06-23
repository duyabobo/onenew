FROM node:24-bookworm-slim

# 安装系统工具：
#   bwrap       沙盒核心
#   iproute2    提供 ip 命令（沙盒启动脚本用 ip link set lo up 启用 loopback）
#   python3     沙盒内 Python 环境
#   ripgrep     pi 依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    ca-certificates \
    curl \
    git \
    iproute2 \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# 全局安装 pi coding agent（锁定版本，升级前先在测试环境验证扩展兼容性）
# 升级步骤：1.改版本号 2.本地 build 测试 3.确认 bwrap 扩展正常工作 4.部署
ARG PI_VERSION=0.79.9
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}

# 安装 pi-mcp-adapter 插件（pi 调用 MCP 服务的唯一社区适配器）
# 等效于交互式环境下执行 `pi install npm:pi-mcp-adapter`
# 原理：npm pack 下载 tarball → 解压到 pi extensions 目录 → 安装依赖（含 @modelcontextprotocol/ext-apps）
RUN mkdir -p /root/.pi/agent/extensions && \
    cd /tmp && \
    npm pack pi-mcp-adapter && \
    mkdir -p /root/.pi/agent/extensions/pi-mcp-adapter && \
    tar -xzf pi-mcp-adapter-*.tgz \
        -C /root/.pi/agent/extensions/pi-mcp-adapter \
        --strip-components=1 && \
    rm /tmp/pi-mcp-adapter-*.tgz && \
    cd /root/.pi/agent/extensions/pi-mcp-adapter && \
    npm install --omit=dev

WORKDIR /app

# 先安装 worker 依赖（含 devDependencies 用于编译 TypeScript）
COPY package.json .
RUN npm install

# 复制源码并编译 TypeScript
COPY tsconfig.json .
COPY src ./src
RUN npm run build

# 复制扩展目录（bwrap extension、sandbox-init）
COPY extensions ./extensions

# 将 bwrap 扩展注册到 pi 默认扩展路径（PI_CODING_AGENT_DIR 指向 session 独立目录，
# session 目录内的 extensions 软链接回此处）
RUN mkdir -p /root/.pi/agent/extensions && \
    cp -r extensions/bwrap /root/.pi/agent/extensions/bwrap && \
    chmod +x extensions/sandbox-init/sandbox-init.sh

# 清理 devDependencies（编译完成后不再需要）
RUN npm prune --omit=dev

# 沙盒临时目录
RUN mkdir -p /tmp/pi-sandbox

ENV NODE_ENV=production
ENV SANDBOX_ROOT=/tmp/pi-sandbox

CMD ["node", "dist/worker.js"]
