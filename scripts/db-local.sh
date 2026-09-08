#!/usr/bin/env bash
# 本地开发数据库（PostgreSQL / Homebrew 本机实例，无 Docker）。
# DATABASE_URL 是 user/password/database/port 的唯一配置源，密钥不硬编码、不输出。
#
# 用法：
#   bash scripts/db-local.sh up       安装（如缺失）+ 初始化（如缺失）+ 启动 + 建库
#   bash scripts/db-local.sh down     停止本项目使用的数据目录实例
#   bash scripts/db-local.sh status   查看实例与端口状态

set -euo pipefail

PG_FORMULA="${PG_FORMULA:-postgresql@16}"
DATA_DIR="${PGDATA:-${HOME}/pgdata/5432}"
LOG_FILE="${PG_LOG_FILE:-${DATA_DIR}.log}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DB_ENV_FILE:-${ROOT}/services/chat/.env.local}"
[[ -f "${ENV_FILE}" ]] || ENV_FILE="${ROOT}/services/chat/.env.local.example"
CMD="${1:-up}"
PG_BIN="${PG_BIN:-}"
PW_FILE=""

fail() {
	echo "❌ $*" >&2
	exit 1
}

cleanup() {
	if [[ -n "${PW_FILE}" && -f "${PW_FILE}" ]]; then
		rm -f "${PW_FILE}"
	fi
}
trap cleanup EXIT

find_pg_bin() {
	if [[ -n "${PG_BIN}" && -x "${PG_BIN}/pg_ctl" ]]; then
		return 0
	fi
	if command -v pg_ctl >/dev/null 2>&1; then
		PG_BIN="$(cd "$(dirname "$(command -v pg_ctl)")" && pwd)"
		return 0
	fi
	if command -v brew >/dev/null 2>&1; then
		local prefix
		prefix="$(brew --prefix "${PG_FORMULA}" 2>/dev/null || true)"
		if [[ -n "$prefix" && -x "$prefix/bin/pg_ctl" ]]; then
			PG_BIN="$prefix/bin"
			return 0
		fi
	fi
	return 1
}

ensure_installed() {
	if find_pg_bin; then
		return
	fi
	command -v brew >/dev/null 2>&1 ||
		fail "未检测到 PostgreSQL 或 Homebrew，请先安装 ${PG_FORMULA}"
	echo "▶ 未检测到 PostgreSQL，正在通过 Homebrew 安装 ${PG_FORMULA} ..."
	brew install "${PG_FORMULA}"
	find_pg_bin || fail "安装后仍未找到 pg_ctl，请执行：brew link --force ${PG_FORMULA}"
}

DATABASE_URL_VALUE="$(grep -E '^DATABASE_URL=' "${ENV_FILE}" | head -n1 | cut -d= -f2- | tr -d "\"'")"
[[ -n "${DATABASE_URL_VALUE}" ]] || fail "${ENV_FILE} 中缺少 DATABASE_URL"

parts=()
while IFS= read -r line; do
	parts+=("$line")
done < <(
	__DB_URL="${DATABASE_URL_VALUE}" bun -e '
    const url = new URL(process.env.__DB_URL);
    for (const value of [
      decodeURIComponent(url.username),
      decodeURIComponent(url.password),
      decodeURIComponent(url.pathname.slice(1)),
      url.port || "5432",
      url.hostname,
    ]) console.log(value);
  '
)

DB_USER="${parts[0]:-}"
DB_PASS="${parts[1]:-}"
DB_NAME="${parts[2]:-}"
DB_PORT="${parts[3]:-5432}"
DB_HOST="${parts[4]:-localhost}"
[[ -n "${DB_USER}" && -n "${DB_NAME}" ]] ||
	fail "DATABASE_URL 解析失败（user=${DB_USER:-空} db=${DB_NAME:-空}）"
[[ "${DB_HOST}" == "localhost" || "${DB_HOST}" == "127.0.0.1" || "${DB_HOST}" == "::1" ]] ||
	fail "db-local.sh 只管理本机数据库，当前 host=${DB_HOST}"
[[ "${DB_PORT}" =~ ^[0-9]+$ ]] || fail "DATABASE_URL 端口无效：${DB_PORT}"

DB_PASS_SQL="$(printf '%s' "${DB_PASS}" | sed "s/'/''/g")"
DB_NAME_SQL="$(printf '%s' "${DB_NAME}" | sed "s/'/''/g")"
DB_USER_IDENT="$(printf '%s' "${DB_USER}" | sed 's/"/""/g')"

is_own_instance_running() {
	"${PG_BIN}/pg_ctl" -D "${DATA_DIR}" status >/dev/null 2>&1
}

is_port_ready() {
	"${PG_BIN}/pg_isready" -h "${DB_HOST}" -p "${DB_PORT}" >/dev/null 2>&1
}

wait_ready() {
	printf '等待数据库就绪'
	for _ in $(seq 1 30); do
		if is_port_ready; then
			echo ' ✅'
			return 0
		fi
		printf '.'
		sleep 1
	done
	echo
	fail "等待超时，请查看日志：${LOG_FILE}"
}

foreign_instance_help() {
	echo "   当前 ${DB_HOST}:${DB_PORT} 由其他 PostgreSQL 实例占用。" >&2
	if [[ -f /Library/LaunchDaemons/postgresql-17.plist ]]; then
		echo "   本机检测到 PostgreSQL 17 系统服务；如决定改用项目 Homebrew 实例，请手动执行：" >&2
		echo "   sudo launchctl bootout system /Library/LaunchDaemons/postgresql-17.plist" >&2
	fi
	echo "   然后重新执行：bun run db:up" >&2
}

case "${CMD}" in
up)
	ensure_installed

	if [[ ! -s "${DATA_DIR}/PG_VERSION" ]]; then
		echo "▶ 初始化数据目录 ${DATA_DIR}（超级用户 ${DB_USER}）"
		mkdir -p "${DATA_DIR}"
		PW_FILE="$(mktemp)"
		chmod 600 "${PW_FILE}"
		printf '%s\n' "${DB_PASS}" >"${PW_FILE}"
		"${PG_BIN}/initdb" -D "${DATA_DIR}" -U "${DB_USER}" -E UTF8 --pwfile="${PW_FILE}"
		rm -f "${PW_FILE}"
		PW_FILE=""
	fi

	if is_own_instance_running; then
		echo "▶ PostgreSQL 已在运行（数据目录 ${DATA_DIR}）"
	else
		if is_port_ready; then
			foreign_instance_help
			fail "无法启动项目数据库：端口 ${DB_PORT} 已被占用"
		fi
		if ! "${PG_BIN}/pg_ctl" -D "${DATA_DIR}" -o "-p ${DB_PORT}" -l "${LOG_FILE}" start >/dev/null; then
			fail "启动失败；请检查端口 ${DB_PORT} 和日志 ${LOG_FILE}"
		fi
		echo "▶ PostgreSQL 已启动（端口 ${DB_PORT}，日志 ${LOG_FILE}）"
	fi

	wait_ready

	PGPASSWORD="${DB_PASS}" "${PG_BIN}/psql" \
		-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres -v ON_ERROR_STOP=1 -q \
		-c "ALTER ROLE \"${DB_USER_IDENT}\" WITH PASSWORD '${DB_PASS_SQL}';" ||
		fail "无法以 ${DB_USER} 连接；请确认 ${ENV_FILE} 与 ${DATA_DIR} 属于同一实例"

	if ! PGPASSWORD="${DB_PASS}" "${PG_BIN}/psql" \
		-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d postgres -tAc \
		"SELECT 1 FROM pg_database WHERE datname='${DB_NAME_SQL}'" | grep -q 1; then
		PGPASSWORD="${DB_PASS}" "${PG_BIN}/createdb" \
			-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "${DB_NAME}"
		echo "▶ 已创建数据库 ${DB_NAME}"
	fi

	echo "连接：postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
	echo "下一步：cd services/chat && bunx prisma migrate deploy && bun run prisma:seed && cd ../.."
	;;

down)
	find_pg_bin || fail "未找到 pg_ctl"
	if is_own_instance_running; then
		"${PG_BIN}/pg_ctl" -D "${DATA_DIR}" stop -m fast >/dev/null
		echo "■ 已停止 PostgreSQL（数据目录 ${DATA_DIR}）"
	else
		echo "PostgreSQL 未在本项目数据目录运行（${DATA_DIR}）"
	fi
	;;

status)
	find_pg_bin || fail "未检测到 PostgreSQL，请先执行：bun run db:up"
	if is_own_instance_running; then
		echo "● 项目数据库运行中（数据目录 ${DATA_DIR}，端口 ${DB_PORT}）"
		"${PG_BIN}/pg_isready" -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" || true
	elif is_port_ready; then
		echo "◐ 项目数据库未运行，但 ${DB_HOST}:${DB_PORT} 已被其他 PostgreSQL 实例占用"
		foreign_instance_help
	else
		echo "○ 项目数据库未运行（数据目录 ${DATA_DIR}，端口 ${DB_PORT}）"
	fi
	;;

*)
	fail "未知命令：${CMD}（可用：up / down / status）"
	;;
esac
