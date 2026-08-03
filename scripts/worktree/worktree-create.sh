#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════╗
# ║   🌳  Git Worktree 快速创建脚本（多 worktree 并行开发版） ║
# ║   用法:                                                  ║
# ║     WORKTREE_BASE_DIR=... \                              ║
# ║     SYMLINK_DIRS="changes" \                             ║
# ║     INSTALL_CMD="bun install" \                          ║
# ║     ./create.sh <branch-name> [worktree-name]            ║
# ║                                                          ║
# ║   特性：                                                 ║
# ║     - 为每个 worktree 自动分配不冲突的 WEB_PORT/API_PORT ║
# ║     - 在 worktree 内生成独立的 .env.local                ║
# ║     - 原项目（REPO_ROOT）固定使用 3001/4001              ║
# ║     - worktree 端口回收复用                              ║
# ╚══════════════════════════════════════════════════════════╝

set -euo pipefail

# ---------- 必需的环境变量（调用前未指明则询问用户） ----------
: "${WORKTREE_BASE_DIR:?请提供 WORKTREE_BASE_DIR（worktree 存放的父目录），或建议在项目 AGENTS.md 中声明}"
: "${SYMLINK_DIRS:?请提供 SYMLINK_DIRS（需软链接的目录名，空格分隔），或建议在项目 AGENTS.md 中声明}"
: "${INSTALL_CMD:?请提供 INSTALL_CMD（依赖安装命令），或建议在项目 AGENTS.md 中声明}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$REPO_ROOT")"

# ---------- 参数 ----------
BRANCH="${1:-}"
WORKTREE_NAME="${2:-}"

if [[ -z "$BRANCH" ]]; then
  echo "❌ 用法: $0 <branch-name> [worktree-name]"
  echo "   示例: $0 feat/poster-editor lingji-poster-editor"
  exit 1
fi

# worktree 名未提供时用 <repo>-<branch 最后一段>
if [[ -z "$WORKTREE_NAME" ]]; then
  WORKTREE_NAME="${REPO_NAME}-$(basename "$BRANCH")"
fi

TARGET_DIR="$WORKTREE_BASE_DIR/$WORKTREE_NAME"

# ---------- 端口分配工具函数 ----------
get_ports_from_env() {
  local env_file="$1"
  if [[ -f "$env_file" ]]; then
    grep -E '^(WEB_PORT|API_PORT)=' "$env_file" || true
  fi
}

read_main_ports() {
  local main_env="$REPO_ROOT/.env.local"
  local web="$(get_ports_from_env "$main_env" | grep '^WEB_PORT=' | cut -d= -f2 | tail -n1)"
  local api="$(get_ports_from_env "$main_env" | grep '^API_PORT=' | cut -d= -f2 | tail -n1)"
  echo "${web:-3001} ${api:-4001}"
}

# 检查端口是否实际被占用（lsof 返回非空表示占用）
port_in_use() {
  local port="$1"
  lsof -ti :"$port" >/dev/null 2>&1
}

# 收集所有 worktree 的 (web, api) 端口对
# 输出格式：每行 "web api"
collect_used_ports() {
  local main_web="$1"
  local main_api="$2"

  # 主目录占用
  echo "$main_web $main_api"

  # 所有 worktree 目录
  git worktree list --porcelain 2>/dev/null | awk '/^worktree / {print $2}' | while read -r wt_dir; do
    # 跳过主仓库本身
    if [[ "$wt_dir" == "$REPO_ROOT" ]]; then
      continue
    fi
    local wt_env="$wt_dir/.env.local"
    if [[ -f "$wt_env" ]]; then
      local web="$(get_ports_from_env "$wt_env" | grep '^WEB_PORT=' | cut -d= -f2 | tail -n1)"
      local api="$(get_ports_from_env "$wt_env" | grep '^API_PORT=' | cut -d= -f2 | tail -n1)"
      if [[ -n "$web" && -n "$api" ]]; then
        echo "$web $api"
      fi
    fi
  done
}

find_next_ports() {
  local main_web="$1"
  local main_api="$2"

  local web_start="$main_web"
  local api_start="$main_api"

  # 收集已用端口到关联数组/集合
  local used_web=()
  local used_api=()

  while read -r web api; do
    [[ -z "$web" ]] && continue
    used_web+=("$web")
    used_api+=("$api")
  done < <(collect_used_ports "$main_web" "$main_api")

  local candidate_web=$((web_start + 1))
  local candidate_api=$((api_start + 1))

  while true; do
    local conflict=0

    # 1. 检查是否已被其他 worktree/主目录声明
    for i in "${!used_web[@]}"; do
      if [[ "${used_web[$i]}" == "$candidate_web" || "${used_api[$i]}" == "$candidate_api" ]]; then
        conflict=1
        break
      fi
    done

    # 2. 检查端口是否实际被占用（其他项目/残留进程）
    if [[ "$conflict" -eq 0 ]]; then
      if port_in_use "$candidate_web"; then
        echo "⚠️  WEB_PORT=$candidate_web 已被其他进程占用，跳过..." >&2
        conflict=1
      elif port_in_use "$candidate_api"; then
        echo "⚠️  API_PORT=$candidate_api 已被其他进程占用，跳过..." >&2
        conflict=1
      fi
    fi

    if [[ "$conflict" -eq 0 ]]; then
      echo "$candidate_web $candidate_api"
      return
    fi

    candidate_web=$((candidate_web + 1))
    candidate_api=$((candidate_api + 1))
  done
}

# 生成 worktree 专用 .env.local
# 策略：优先复制主目录 .env.local（保留所有真实配置），
#       然后只覆盖端口相关字段；如果主目录没有，再回退到 example 模板。
generate_worktree_env() {
  local target="$1"
  local web_port="$2"
  local api_port="$3"

  local env_file="$target/.env.local"
  local main_env="$REPO_ROOT/.env.local"
  local env_example="$REPO_ROOT/.env.local.example"
  local source_env=""

  if [[ -f "$main_env" ]]; then
    source_env="$main_env"
  elif [[ -f "$env_example" ]]; then
    source_env="$env_example"
  fi

  if [[ -z "$source_env" ]]; then
    # 兜底：生成最小版本
    cat > "$env_file" <<EOF
# ============================================
# LingJi 跨服务共享环境变量 - 开发环境（worktree 专用）
# ============================================
# 📌 自动生成，请勿提交到 Git
# Worktree: $(basename "$target")
# ============================================

# ---- 端口 ----
API_PORT=$api_port
WEB_PORT=$web_port

# ---- 跨服务通信 ----
CORS_ORIGIN=http://localhost:$web_port
NEXT_PUBLIC_API_BASE_URL=http://localhost:$api_port/api
NEXT_PUBLIC_API_URL=http://localhost:$api_port/api
EOF
    echo "📝 已生成最小 worktree 专属 .env.local：WEB_PORT=$web_port, API_PORT=$api_port"
    return
  fi

  # 复制源文件，并只覆盖端口相关字段
  sed -e "s/^WEB_PORT=.*/WEB_PORT=$web_port/" \
      -e "s/^API_PORT=.*/API_PORT=$api_port/" \
      -e "s|^CORS_ORIGIN=.*|CORS_ORIGIN=http://localhost:$web_port|" \
      -e "s|^NEXT_PUBLIC_API_BASE_URL=.*|NEXT_PUBLIC_API_BASE_URL=http://localhost:$api_port/api|" \
      -e "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=http://localhost:$api_port/api|" \
      "$source_env" > "$env_file"

  # 添加/更新 worktree 标识注释（放在文件顶部）
  local marker="# === Worktree: $(basename "$target") | WEB_PORT=$web_port | API_PORT=$api_port ==="
  if grep -q "^# === Worktree:" "$env_file"; then
    sed -i '' "s|^# === Worktree:.*|$marker|" "$env_file"
  else
    local tmp="$(mktemp)"
    {
      echo "$marker"
      echo "# 📌 此文件为 worktree 自动生成，覆盖原项目端口以避免冲突"
      echo ""
      cat "$env_file"
    } > "$tmp"
    mv "$tmp" "$env_file"
  fi

  echo "📝 已生成 worktree 专属 .env.local：WEB_PORT=$web_port, API_PORT=$api_port"
}

# ---------- 计算端口 ----------
read -r MAIN_WEB MAIN_API < <(read_main_ports)
echo "🔌 主项目端口: WEB_PORT=$MAIN_WEB, API_PORT=$MAIN_API"

read -r NEXT_WEB NEXT_API < <(find_next_ports "$MAIN_WEB" "$MAIN_API")

# ---------- 创建 worktree ----------
echo "=================================================="
echo "  📦 分支名称: $BRANCH"
echo "  📁 目标路径: $TARGET_DIR"
echo "  🔗 软链接目录: $SYMLINK_DIRS"
echo "  🔌 分配端口: WEB_PORT=$NEXT_WEB, API_PORT=$NEXT_API"
echo "=================================================="

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "✅ 分支已存在，直接检出..."
  git worktree add "$TARGET_DIR" "$BRANCH"
else
  echo "🆕 分支不存在，基于当前 HEAD 新建分支..."
  git worktree add -b "$BRANCH" "$TARGET_DIR"
fi

# ---------- 生成独立环境文件 ----------
generate_worktree_env "$TARGET_DIR" "$NEXT_WEB" "$NEXT_API"

# ---------- 建立软链接 ----------
cd "$TARGET_DIR"
for dir in $SYMLINK_DIRS; do
  # 不能软链接 .env 相关文件
  if [[ "$dir" == ".env" || "$dir" == ".env.local" || "$dir" == ".env.*" ]]; then
    echo "⚠️  跳过环境文件软链接: $dir"
    continue
  fi

  # 不能软链接 .claude：其下 rules/ 等团队规范已被 git 跟踪，worktree 检出时自带。
  # 软链会造成「worktree 是软链接、主仓库是真目录」的类型不一致，
  # git 会留下 .claude~<分支名> 备份文件，合并时引发 UA 冲突。
  if [[ "$dir" == ".claude" || "$dir" == .claude/* ]]; then
    echo "⚠️  跳过 .claude 软链接（已被 git 跟踪，worktree 检出时自带，软链会导致合并冲突）: $dir"
    continue
  fi

  src="$REPO_ROOT/$dir"
  if [[ ! -e "$src" ]]; then
    echo "⚠️  源目录 $src 不存在，跳过。"
    continue
  fi
  if [[ -e "$dir" || -L "$dir" ]]; then
    echo "ℹ️  $dir 已存在，跳过软链接。"
    continue
  fi
  ln -s "$src" "$dir"
  echo "🔗 已创建软链接: $dir → $src"
done

# ---------- 安装依赖 ----------
if [[ -f "package.json" ]]; then
  echo "📥 安装依赖: $INSTALL_CMD"
  eval "$INSTALL_CMD" || echo "⚠️  依赖安装失败，请手动执行 $INSTALL_CMD"
else
  echo "ℹ️  未检测到 package.json，跳过依赖安装。"
fi

echo ""
echo "=================================================="
echo "  🎉 Worktree 创建完成！"
echo "  👉 cd $TARGET_DIR"
echo "  🚀 启动命令: bun run dev"
echo "  🌐 前端地址: http://localhost:$NEXT_WEB"
echo "  🔌 后端地址: http://localhost:$NEXT_API"
echo "=================================================="
