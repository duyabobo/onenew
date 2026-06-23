#!/bin/bash
#
# bwrap 沙盒启动脚本：初始化网络环境，启动 TCP→Unix socket 桥，然后 exec pi。
#
# 调用方式：sandbox-init.sh pi [pi-args...]
# 执行环境：bwrap 内部（--unshare-net 新网络命名空间）
#
# 步骤：
#   1. 启用 loopback 接口（新网络命名空间默认 lo 处于 DOWN 状态）
#   2. 启动 bridge.js（将 loopback TCP 端口桥接到挂载进来的 Unix socket）
#   3. exec pi（替换当前进程，stdin/stdout 透传给 pi-session.ts）

set -e

# 启用 loopback（--unshare-net 创建的新 netns 中 lo 默认是 DOWN）
ip link set lo up

# 启动网络桥（后台运行，输出到 stderr）
node /app/extensions/sandbox-init/bridge.js &
BRIDGE_PID=$!

# 给桥一点时间监听就绪（bridge.js 启动极快，0.1s 足够）
sleep 0.1

# exec 替换当前进程，stdin/stdout 直接连接到 pi
exec "$@"
