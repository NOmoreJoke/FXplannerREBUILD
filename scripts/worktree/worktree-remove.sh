#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════╗
# ║   🗑️  Git Worktree 删除脚本（带端口回收提示）            ║
# ║   用法:                                                  ║
# ║     ./remove.sh [worktree-path-or-name]                  ║
# ║                                                          ║
# ║   特性：                                                 ║
# ║     - 删除前检查未提交改动                               ║
# ║     - 提示该 worktree 占用的端口已释放                   ║
# ║     - 可选同时删除对应分支                               ║
# ╚══════════════════════════════════════════════════════════╝

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# ---------- 工具函数 ----------
get_ports_from_env() {
  local env_file="$1"
  if [[ -f "$env_file" ]]; then
    grep -E '^(WEB_PORT|API_PORT)=' "$env_file" || true
  fi
}

# 列出所有非主目录 worktree
list_worktrees() {
  git worktree list --porcelain 2>/dev/null | awk '/^worktree / {print $2}' | while read -r wt_dir; do
    if [[ "$wt_dir" != "$REPO_ROOT" ]]; then
      echo "$wt_dir"
    fi
  done
}

# ---------- 参数解析 ----------
TARGET_INPUT="${1:-}"

if [[ -z "$TARGET_INPUT" ]]; then
  echo "当前所有 worktree："
  mapfile -t WORKTREES < <(list_worktrees)
  if [[ ${#WORKTREES[@]} -eq 0 ]]; then
    echo "  （无）"
    exit 0
  fi
  for i in "${!WORKTREES[@]}"; do
    echo "  [$i] ${WORKTREES[$i]}"
  done
  echo ""
  read -rp "请输入要删除的 worktree 编号或路径: " TARGET_INPUT

  # 如果是纯数字，转索引
  if [[ "$TARGET_INPUT" =~ ^[0-9]+$ ]]; then
    TARGET_INPUT="${WORKTREES[$TARGET_INPUT]}"
  fi
fi

# 支持传 worktree 名（basename）或完整路径
if [[ -d "$TARGET_INPUT" ]]; then
  TARGET_DIR="$TARGET_INPUT"
else
  # 尝试从 worktree base 找
  if git worktree list --porcelain 2>/dev/null | grep -q "^worktree $TARGET_INPUT$"; then
    TARGET_DIR="$TARGET_INPUT"
  else
    # 尝试作为 basename
    FOUND="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree / {print $2}' | grep "/${TARGET_INPUT}$" || true)"
    if [[ -n "$FOUND" ]]; then
      TARGET_DIR="$FOUND"
    else
      echo "❌ 找不到 worktree: $TARGET_INPUT"
      exit 1
    fi
  fi
fi

# 解析分支名
BRANCH="$(git worktree list --porcelain 2>/dev/null | awk -v dir="$TARGET_DIR" '
  /^worktree / { current=$2 }
  /^branch / { print $2; exit }
' | sed 's|^refs/heads/||')"

# 读取端口
ENV_FILE="$TARGET_DIR/.env.local"
WEB_PORT=""
API_PORT=""
if [[ -f "$ENV_FILE" ]]; then
  WEB_PORT="$(get_ports_from_env "$ENV_FILE" | grep '^WEB_PORT=' | cut -d= -f2 | tail -n1)"
  API_PORT="$(get_ports_from_env "$ENV_FILE" | grep '^API_PORT=' | cut -d= -f2 | tail -n1)"
fi

echo "=================================================="
echo "  🗑️  即将删除 worktree"
echo "  📁 路径: $TARGET_DIR"
if [[ -n "$BRANCH" ]]; then
  echo "  🌿 分支: $BRANCH"
fi
if [[ -n "$WEB_PORT" && -n "$API_PORT" ]]; then
  echo "  🔌 占用端口: WEB_PORT=$WEB_PORT, API_PORT=$API_PORT（删除后释放）"
fi
echo "=================================================="

# ---------- 检查未提交改动 ----------
cd "$TARGET_DIR"
if [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
  echo "⚠️  检测到未提交改动："
  git status --short
  read -rp "是否继续删除？未提交改动将丢失 [y/N]: " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "已取消。"
    exit 0
  fi
else
  read -rp "确认删除该 worktree？ [y/N]: " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "已取消。"
    exit 0
  fi
fi

# ---------- 执行删除 ----------
cd "$REPO_ROOT"
git worktree remove "$TARGET_DIR" --force

# 删除成功后的提示
echo ""
echo "✅ Worktree 已删除: $TARGET_DIR"
if [[ -n "$WEB_PORT" && -n "$API_PORT" ]]; then
  echo "🔓 端口已释放: WEB_PORT=$WEB_PORT, API_PORT=$API_PORT"
fi

# 询问是否删除分支
if [[ -n "$BRANCH" ]] && git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  read -rp "是否同时删除分支 $BRANCH？ [y/N]: " del_branch
  if [[ "$del_branch" == "y" || "$del_branch" == "Y" ]]; then
    git branch -D "$BRANCH"
    echo "🌿 分支已删除: $BRANCH"
  fi
fi

echo ""
echo "=================================================="
echo "  🎉 Worktree 删除完成"
echo "=================================================="
