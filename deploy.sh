#!/usr/bin/env bash
# Pi Agent Platform 一键部署脚本
# 用法：
#   bash deploy.sh              # 单节点开发部署
#   bash deploy.sh --prod       # 生产集群部署（需配置 NFS 相关环境变量）
#   bash deploy.sh --scale 3    # 生产部署，pi-runtime 启动 3 个实例
#   bash deploy.sh --down       # 停止并移除所有容器（保留数据卷）
#   bash deploy.sh --clean      # 停止并移除容器 + 数据卷（谨慎：会清空用户 workspace）

set -euo pipefail

# ── 颜色输出 ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# ── 解析参数 ─────────────────────────────────────────────────────────────────────
MODE="dev"
PI_RUNTIME_REPLICAS=1
COMPOSE_FILES="-f docker-compose.yml"

while [[ $# -gt 0 ]]; do
  case $1 in
    --prod)   MODE="prod"; COMPOSE_FILES="-f docker-compose.yml -f docker-compose.prod.yml"; shift ;;
    --scale)  PI_RUNTIME_REPLICAS="${2:?--scale 需要指定实例数}"; shift 2 ;;
    --down)   MODE="down"; shift ;;
    --clean)  MODE="clean"; shift ;;
    *) error "未知参数: $1" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 前置检查 ─────────────────────────────────────────────────────────────────────
check_prerequisites() {
  info "检查前置依赖..."
  command -v docker   &>/dev/null || error "未找到 docker，请先安装 Docker"
  command -v docker compose &>/dev/null || \
    docker compose version &>/dev/null  || error "未找到 docker compose，请升级 Docker"

  # 检查 privileged 支持（pi-runtime bwrap 需要）
  if ! docker info 2>/dev/null | grep -q "Operating System"; then
    error "Docker daemon 未运行"
  fi

  success "前置依赖检查通过"
}

# ── 环境变量初始化 ───────────────────────────────────────────────────────────────
setup_env() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    warn ".env 不存在，已从 .env.example 创建，请填写以下必要配置后重新运行："
    echo ""
    echo "  LLM_API_KEY=<你的 LLM API Key>"
    echo "  LLM_BASE_URL=<LLM 接口地址>"
    echo ""
    exit 1
  fi

  # 检查必要变量
  # shellcheck source=/dev/null
  source .env
  [[ -z "${LLM_API_KEY:-}" ]] && error ".env 中 LLM_API_KEY 未设置"
  [[ -z "${LLM_BASE_URL:-}" ]] && error ".env 中 LLM_BASE_URL 未设置"

  if [[ "$MODE" == "prod" ]]; then
    [[ -z "${NFS_SERVER_ADDR:-}" ]] && error "生产模式需要设置 NFS_SERVER_ADDR"
    [[ -z "${NFS_EXPORT_PATH:-}" ]] && error "生产模式需要设置 NFS_EXPORT_PATH"
  fi

  success "环境变量检查通过"
}

# ── 停止 ────────────────────────────────────────────────────────────────────────
do_down() {
  info "停止所有容器..."
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES down
  success "所有容器已停止（数据卷保留）"
}

do_clean() {
  warn "即将删除所有容器和数据卷（包含用户 workspace 数据），5 秒后继续，Ctrl+C 取消..."
  sleep 5
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES down -v
  success "所有容器和数据卷已清理"
}

# ── 构建 ────────────────────────────────────────────────────────────────────────
do_build() {
  info "构建服务镜像..."
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES build --parallel
  success "镜像构建完成"
}

# ── 启动 ────────────────────────────────────────────────────────────────────────
do_start() {
  info "启动所有服务（pi-runtime x${PI_RUNTIME_REPLICAS}）..."
  # shellcheck disable=SC2086
  docker compose $COMPOSE_FILES up -d \
    --scale pi-runtime="$PI_RUNTIME_REPLICAS" \
    --remove-orphans
  success "容器已启动"
}

# ── 等待健康检查 ─────────────────────────────────────────────────────────────────
wait_healthy() {
  local services=("mongo" "redis" "admin" "gateway" "frontend")
  local timeout=120
  local interval=5

  info "等待服务就绪（最多 ${timeout}s）..."
  for svc in "${services[@]}"; do
    local elapsed=0
    while true; do
      local state
      state=$(docker compose $COMPOSE_FILES ps -q "$svc" 2>/dev/null | \
              xargs -r docker inspect --format='{{.State.Health.Status}}' 2>/dev/null || echo "unknown")

      if [[ "$state" == "healthy" ]]; then
        success "$svc 就绪"
        break
      fi

      if (( elapsed >= timeout )); then
        error "$svc 在 ${timeout}s 内未就绪，当前状态: $state"
      fi

      sleep "$interval"
      (( elapsed += interval ))
    done
  done
}

# ── 输出访问信息 ─────────────────────────────────────────────────────────────────
print_summary() {
  echo ""
  echo "═══════════════════════════════════════════"
  echo "  Pi Agent Platform 部署完成"
  echo "═══════════════════════════════════════════"
  echo ""
  echo "  模式：$([ "$MODE" == "prod" ] && echo "生产集群" || echo "单节点开发")"
  echo "  pi-runtime 实例数：${PI_RUNTIME_REPLICAS}"
  echo ""
  echo "  服务地址："
  echo "    前端     →  http://localhost:3000"
  echo "    Gateway  →  http://localhost:8000"
  echo "    Admin    →  http://localhost:9000"
  echo ""
  echo "  API 示例："
  echo "    # 创建会话"
  echo "    curl -X POST http://localhost:8000/sessions \\"
  echo "      -H 'Content-Type: application/json' \\"
  echo "      -d '{\"user_id\": \"alice\", \"request\": \"帮我写一个 hello world\"}'"
  echo ""
  echo "    # 拉取 SSE 流（替换 SESSION_ID）"
  echo "    curl -N http://localhost:8000/sessions/SESSION_ID/stream"
  echo ""
  echo "  查看日志："
  echo "    docker compose logs -f gateway"
  echo "    docker compose logs -f pi-runtime"
  echo ""
}

# ── 主流程 ───────────────────────────────────────────────────────────────────────
main() {
  echo ""
  info "Pi Agent Platform 部署脚本"
  echo ""

  case "$MODE" in
    down)  check_prerequisites; do_down; exit 0 ;;
    clean) check_prerequisites; do_clean; exit 0 ;;
  esac

  check_prerequisites
  setup_env
  do_build
  do_start
  wait_healthy
  print_summary
}

main
