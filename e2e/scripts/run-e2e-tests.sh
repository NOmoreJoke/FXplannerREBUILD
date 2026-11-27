#!/bin/bash

# ============================================================================
# FXPlanner E2E 全流程测试脚本（changes/ux-improvements 修复重写）
# ============================================================================
#
# 用途：拉起前后端 dev 服务 → 健康检查 → 运行 e2e/modules 全部用例 →
#       汇总截图/日志/报告 → 关闭服务（服务生命周期由本脚本统一管理）
#
# 使用方法：
#   ./run-e2e-tests.sh                # 默认 headed（呼出浏览器，可视化过程）
#   ./run-e2e-tests.sh --headless     # 无界面模式（CI 用）
#   ./run-e2e-tests.sh --grep T-NAV   # 只跑匹配的用例
#
# 产物（全部收敛在 e2e/test-results/）：
#   screenshots/       关键页面截图留存（跨运行保留）
#   playwright-report/ HTML 报告
#   logs/              dev 服务日志 + 用例日志
# ============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

cd "$(dirname "$0")/../.." # monorepo 根目录

# ============================================================================
# 1. 参数与环境
# ============================================================================
HEADED_ARGS=("--headed")
TEST_FILTER=""
while [ $# -gt 0 ]; do
	case $1 in
	--headless)
		HEADED_ARGS=()
		print_info "已启用无界面模式"
		;;
	--grep)
		TEST_FILTER="$2"
		shift
		;;
	esac
	shift
done

print_info "=========================================="
print_info "FXPlanner E2E 全流程测试"
print_info "=========================================="

if ! command -v bun &>/dev/null; then
	print_error "Bun 未安装"
	exit 1
fi
print_success "bun $(bun --version)"

if [ ! -f ".env.local" ]; then
	print_error "缺少根目录 .env.local（WEB_PORT/API_PORT 等）"
	exit 1
fi

# 读取端口（dotenv 语义：仅 KEY=VALUE 行）
get_env() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2; }
WEB_PORT="$(get_env WEB_PORT)"
WEB_PORT="${WEB_PORT:-3001}"
API_PORT="$(get_env API_PORT)"
API_PORT="${API_PORT:-4001}"
DEV_LOG_PORT="$(get_env DEV_LOG_PORT)"
DEV_LOG_PORT="${DEV_LOG_PORT:-8787}"
export CORS_ORIGIN="http://localhost:${WEB_PORT}"
export WEB_PORT API_PORT DEV_LOG_PORT
# e2e 造数 helper（api-seeder）的后端地址：对齐实际 API 端口
export API_URL="http://localhost:${API_PORT}"
# E2E 必须走邮件 mock（用例依赖响应里的 devCode 取码）：
# 若不强制，dev 服务会继承 services/chat/.env.local 的真实 SMTP 配置 → 真发邮件且无 devCode，E2E 全挂
export OTP_EMAIL_MOCK=true
# E2E 集中造数会触发限流（auth 5/10 次每分、全局 10 次每分）→ 测试运行时放大（生产默认不变）
export AUTH_THROTTLE_LIMIT=200
export AUTH_OTP_THROTTLE_LIMIT=200
# 发码接口另有按 IP 的频控（默认 5 次/分；otp.service 读 OTP_IP_MAX_REQUESTS 覆盖）。
# 同一回环 IP 上集中造数 / 页面内多次发码同样会撞上，与上面两项一起放大
export OTP_IP_MAX_REQUESTS=200
export THROTTLE_GLOBAL_LIMIT=500
# 行情 E2E（changes/rate-chart §5.3）：RATE_SOURCE=frankfurter 单源降级开关——
# 未被用例网络层 stub 拦截的汇率外呼一律单源走 frankfurter，避免 E2E 真实外呼农行 ABC 源
export RATE_SOURCE=frankfurter
# AI 助手 E2E（changes/ai-assistant §5.3）：假流式模型开关——LlmFactory 切换官方
# FakeStreamingChatModel（真链路前端→后端 SSE→fake LLM，零外呼）；services/chat 的
# dotenv 不覆盖已存在 process.env，export 必然生效。AI_* 变量其他模块不读，对既有用例零影响
export AI_E2E_FAKE_STREAM=true
# 降级 gate 要求至少一个白名单模型密钥可用（resolve 期快照，ai-runtime-config.ts），
# fake 模式不外呼、占位即可（changes/ai-model-whitelist/技术方案.md §5.3）
export AI_PROVIDER_AIGYSD_API_KEY=e2e-dummy
# 帧间隔放大（默认 30ms）：固定回复 38 字符 × 80ms ≈ 3s 流窗口，保证「光标出现→点停止」时序余量
export AI_E2E_FAKE_INTERVAL_MS=80
# AI 发消息端点的 IP 级限流在 E2E 集中运行时同步放大（默认 5/min 在 14-ai-chat + 16-agent-organization 连续跑下不够）
export AI_SEND_THROTTLE_LIMIT="${AI_SEND_THROTTLE_LIMIT:-200}"
# 种子运行 ID（e2e/helpers/api-seeder）：beforeAll 在失败重试时会被 Playwright
# 重跑；RUN_ID 单次运行内稳定使重试复用同一种子用户，避免依赖跨用例状态的
# 模块（AI 会话链）级联失败。跨调用间自动更换，保持运行间隔离。
export E2E_SEED_RUN_ID="${E2E_SEED_RUN_ID:-$(date +%s)}"

# 报价更正 E2E（T-CORR-005）会写全局报价表 exchange_rates：helper 以 FXPLANNER_E2E_QUOTE_DATABASE
# 为安全闸门，值必须等于后端实际连接的库名（此前靠人工导出，漏导即整条用例失败）。
# 后端 DATABASE_URL 取自 services/chat/.env.local（回退 .env，与 services/chat/src/config/env.ts
# 同序），这里解析库名后注入；已从外部显式传入时沿用外部值。
# 仅回环主机（localhost / 127.0.0.1 / ::1）才注入——非本机库不注入，闸门保持关闭。
read_chat_database_url() {
	local file line value
	for file in services/chat/.env.local services/chat/.env; do
		[ -f "${file}" ] || continue
		line="$(grep -E '^DATABASE_URL=' "${file}" | head -1 || true)"
		value="${line#DATABASE_URL=}"
		# dotenv 语义：剥掉包裹引号（单/双）
		if [ "${#value}" -ge 2 ]; then
			case "${value}" in
				\"*\") value="${value%\"}"; value="${value#\"}" ;;
				\'*\') value="${value%\'}"; value="${value#\'}" ;;
			esac
		fi
		if [ -n "${value}" ]; then
			printf '%s' "${value}"
			return 0
		fi
	done
	return 1
}
LOCAL_DB_NAME=""
LOCAL_DB_HOST=""
if CHAT_DATABASE_URL="$(read_chat_database_url)"; then
	url_rest="${CHAT_DATABASE_URL#*://}" # 去协议
	url_rest="${url_rest%%\?*}"          # 去查询参数
	url_hostport="${url_rest%%/*}"       # host[:port]（可能带 userinfo）
	url_hostport="${url_hostport##*@}"   # 去 userinfo
	case "${url_hostport}" in
		\[*)
			LOCAL_DB_HOST="${url_hostport%%\]*}"
			LOCAL_DB_HOST="${LOCAL_DB_HOST#[}"
			;;
		*)
			LOCAL_DB_HOST="${url_hostport%%:*}"
			;;
	esac
	LOCAL_DB_NAME="${url_rest#*/}"
fi
case "${LOCAL_DB_HOST}" in
	localhost | 127.0.0.1 | ::1)
		export FXPLANNER_E2E_QUOTE_DATABASE="${FXPLANNER_E2E_QUOTE_DATABASE:-$LOCAL_DB_NAME}"
		print_info "报价更正 E2E 闸门：FXPLANNER_E2E_QUOTE_DATABASE=${FXPLANNER_E2E_QUOTE_DATABASE}"
		;;
	*)
		if [ -z "${FXPLANNER_E2E_QUOTE_DATABASE:-}" ]; then
			print_warning "DATABASE_URL 非回环主机或无法解析（host='${LOCAL_DB_HOST}'），未注入 FXPLANNER_E2E_QUOTE_DATABASE：T-CORR-005 会被安全闸门拒绝"
		fi
		;;
esac

# ============================================================================
# 2. 清理端口 → 启动服务
# ============================================================================
print_info "清理端口 ${WEB_PORT}/${API_PORT}/${DEV_LOG_PORT}..."
lsof -ti :"${WEB_PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :"${API_PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :"${DEV_LOG_PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true

mkdir -p e2e/test-results/logs e2e/test-results/screenshots
# chat 服务 dev 脚本会 tee logs/dev.log，运行时目录必须存在（产物 gitignored）
mkdir -p services/chat/logs

print_info "启动 dev 服务（turbo 同时拉起前后端）..."
bun run dev >e2e/test-results/logs/dev-server.log 2>&1 &
DEV_PID=$!
print_success "dev 已启动 (PID: ${DEV_PID})"

cleanup() {
	if [ -n "${DEV_PID}" ]; then
		print_info "关闭 dev 服务..."
		kill "${DEV_PID}" 2>/dev/null || true
		# turbo 子进程（next/nest/dev-log-server）一并回收
		lsof -ti :"${WEB_PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
		lsof -ti :"${API_PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
		lsof -ti :"${DEV_LOG_PORT}" 2>/dev/null | xargs kill -9 2>/dev/null || true
	fi
}
trap cleanup EXIT

# ============================================================================
# 3. 健康检查（前端 200 / 后端 /api/health）
# ============================================================================
wait_for() {
	local name="$1" url="$2" tries="${3:-60}"
	for _ in $(seq 1 "${tries}"); do
		if curl -sf -o /dev/null "${url}"; then
			print_success "${name} 就绪：${url}"
			return 0
		fi
		sleep 1
	done
	print_error "${name} 启动超时：${url}"
	tail -50 e2e/test-results/logs/dev-server.log || true
	return 1
}

wait_for "后端 API" "http://localhost:${API_PORT}/api/health"
wait_for "前端 Web" "http://localhost:${WEB_PORT}"

# ============================================================================
# 4. 运行 Playwright（真实前后端，不做接口 mock）
# ============================================================================
print_info "运行 E2E 用例（e2e/modules）..."
PW_ARGS=("${HEADED_ARGS[@]}")
if [ -n "${TEST_FILTER}" ]; then
	PW_ARGS+=(--grep "${TEST_FILTER}")
fi

set +e
bunx playwright test e2e/modules "${PW_ARGS[@]}"
TEST_EXIT_CODE=$?
set -e

# ============================================================================
# 5. 结果汇总
# ============================================================================
print_info "=========================================="
SCREENSHOT_COUNT=$(find e2e/test-results/screenshots -name "*.png" 2>/dev/null | wc -l | tr -d ' ')
print_success "📸 关键页面截图留存：${SCREENSHOT_COUNT} 张"
find e2e/test-results/screenshots -name "*.png" 2>/dev/null | sed 's/^/   - /'

if [ "${TEST_EXIT_CODE}" -eq 0 ]; then
	print_success "全部测试通过（0 failed）"
else
	print_warning "存在失败用例（退出码 ${TEST_EXIT_CODE}），详见 HTML 报告"
fi

print_success "HTML 报告：e2e/test-results/playwright-report/index.html"
print_success "服务日志：e2e/test-results/logs/dev-server.log"
print_info "查看报告：bunx playwright show-report e2e/test-results/playwright-report"

exit "${TEST_EXIT_CODE}"
