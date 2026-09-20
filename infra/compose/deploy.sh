#!/usr/bin/env bash
# FXPlanner 生产部署脚本（服务器 /opt/fxplanner 下执行）
# 用法：bash deploy.sh          # 拉镜像 + 迁移 + 启动/更新
#       bash deploy.sh rollback # 回滚到上一次拉取的镜像（不删数据）
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose --env-file .env -f compose.prod.yaml"

case "${1:-deploy}" in
  deploy)
    echo "==> 1/4 拉取镜像"
    $COMPOSE pull chat web
    echo "==> 2/4 启动数据库并等待就绪"
    $COMPOSE up -d postgres
    $COMPOSE wait postgres
    echo "==> 3/4 数据库迁移（prisma migrate deploy）"
    $COMPOSE run --rm chat \
      bunx prisma migrate deploy --schema services/chat/prisma/schema.prisma
    echo "==> 4/4 启动/更新服务"
    $COMPOSE up -d
    ;;
  rollback)
    echo "==> 回滚：恢复上一个 tag 镜像需事先另行保留，此处仅重启当前镜像"
    $COMPOSE restart chat web
    ;;
  *)
    echo "未知命令：$1（可用：deploy | rollback）" >&2
    exit 1
    ;;
esac

echo "==> 当前状态"
$COMPOSE ps
echo "==> 完成。健康检查：curl -s http://127.0.0.1:4101/api/health"
