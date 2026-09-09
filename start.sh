#!/usr/bin/env bash
# 知识库问答 Agent —— 本地/服务器 一键启动脚本
# 用法：
#   ./start.sh            # 安装依赖 + 构建 + 启动（默认端口 3210）
#   PORT=8080 ./start.sh  # 指定端口
set -e

cd "$(dirname "$0")"

PORT="${PORT:-3210}"
export PORT

echo "==> 安装依赖..."
npm install

echo "==> 类型检查 + 构建前端..."
npm run build

echo "==> 启动服务（端口 ${PORT}）..."
echo "    访问地址: http://localhost:${PORT}"
echo "    Ctrl+C 停止"
exec npx tsx server/index.ts
