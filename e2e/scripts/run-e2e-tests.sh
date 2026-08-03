#!/bin/bash

# ============================================================================
# LingJi 完整功能 E2E 测试脚本
# ============================================================================
#
# 用途：运行所有 E2E 测试，包括完整的功能工作流，并生成截图和报告
#
# 使用方法：
#   ./run-e2e-tests.sh              # 运行所有测试
#   ./run-e2e-tests.sh --headed     # 有界面模式（便于观察）
#   ./run-e2e-tests.sh --debug      # 调试模式
#
# ============================================================================

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() {
	echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
	echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
	echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
	echo -e "${RED}❌ $1${NC}"
}

# ============================================================================
# 1. 检查环境
# ============================================================================

print_info "=========================================="
print_info "LingJi 完整功能 E2E 测试"
print_info "=========================================="
print_info ""

print_info "1️⃣  检查环境..."

# 检查 Node.js
if ! command -v node &>/dev/null; then
	print_error "Node.js 未安装，请先安装 Node.js"
	exit 1
fi
print_success "Node.js 已安装: $(node --version)"

# 检查 bun
if ! command -v bun &>/dev/null; then
	print_error "Bun 未安装，请先安装 Bun"
	exit 1
fi
print_success "Bun 已安装: $(bun --version)"

# 检查环境变量
if [ -z "$CORS_ORIGIN" ]; then
	print_warning "CORS_ORIGIN 环境变量未设置，使用默认值: http://localhost:3001"
	export CORS_ORIGIN="http://localhost:3001"
else
	print_success "CORS_ORIGIN: $CORS_ORIGIN"
fi

# ============================================================================
# 2. 创建输出目录
# ============================================================================

print_info ""
print_info "2️⃣  创建输出目录..."

mkdir -p e2e/test-results/full-workflow
mkdir -p e2e/test-results/logs
mkdir -p e2e/test-results/playwright-report

print_success "输出目录已创建"

# ============================================================================
# 3. 加载环境变量
# ============================================================================

print_info ""
print_info "3️⃣  加载环境变量..."

if [ -f ".env.local" ]; then
	set -a
	source .env.local
	set +a
	print_success ".env.local 已加载"
else
	print_warning ".env.local 未找到"
fi

# ============================================================================
# 4. 启动开发服务器（如果没有运行）
# ============================================================================

print_info ""
print_info "4️⃣  启动开发服务器..."

# 检查 3001 端口是否已在使用
if ! nc -z localhost 3001 2>/dev/null; then
	print_info "启动 Next.js 开发服务器..."
	# 在后台启动服务器
	bun run dev >e2e/test-results/logs/dev-server.log 2>&1 &
	DEV_SERVER_PID=$!
	print_success "开发服务器已启动 (PID: $DEV_SERVER_PID)"

	# 等待服务器启动
	print_info "等待服务器启动（最多 30 秒）..."
	for i in {1..30}; do
		if nc -z localhost 3001 2>/dev/null; then
			print_success "服务器已就绪"
			break
		fi
		sleep 1
	done
else
	print_success "开发服务器已在运行"
fi

# ============================================================================
# 5. 准备 Playwright 测试参数
# ============================================================================

print_info ""
print_info "5️⃣  准备测试参数..."

TEST_ARGS=""

# 检查命令行参数
for arg in "$@"; do
	case $arg in
	--headed)
		TEST_ARGS="--headed"
		print_success "已启用有界面模式"
		;;
	--debug)
		TEST_ARGS="--debug"
		print_success "已启用调试模式"
		;;
	--filter)
		# 过滤特定测试
		TEST_FILTER="$2"
		shift
		print_success "测试过滤: $TEST_FILTER"
		;;
	esac
done

# ============================================================================
# 6. 运行 Playwright 测试
# ============================================================================

print_info ""
print_info "6️⃣  运行 Playwright 测试..."
print_info "=========================================="

# 导出环境变量供测试使用
export CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:3001}"

# 运行测试
if [ -n "$TEST_FILTER" ]; then
	npx playwright test e2e/full-feature-workflow.spec.ts $TEST_ARGS --grep "$TEST_FILTER"
else
	npx playwright test e2e/full-feature-workflow.spec.ts $TEST_ARGS
fi

TEST_EXIT_CODE=$?

print_info ""
print_info "=========================================="

# ============================================================================
# 7. 收集和展示结果
# ============================================================================

print_info ""
print_info "7️⃣  收集测试结果..."

# 统计截图数量
SCREENSHOT_COUNT=$(find e2e/test-results/full-workflow -name "*.png" 2>/dev/null | wc -l)
print_success "📸 生成了 $SCREENSHOT_COUNT 张截图"

# 显示截图列表
if [ $SCREENSHOT_COUNT -gt 0 ]; then
	print_info "截图列表："
	ls -lh e2e/test-results/full-workflow/*.png 2>/dev/null | awk '{print "  - " $NF}'
fi

# 检查日志
if [ -f "e2e/test-results/logs/dev-server.log" ]; then
	print_success "开发服务器日志: e2e/test-results/logs/dev-server.log"
fi

# ============================================================================
# 8. 生成报告
# ============================================================================

print_info ""
print_info "8️⃣  生成测试报告..."

if [ $TEST_EXIT_CODE -eq 0 ]; then
	print_success "所有测试通过！"
else
	print_warning "部分测试失败（退出码: $TEST_EXIT_CODE）"
fi

print_success "HTML 报告: e2e/test-results/playwright-report/index.html"
print_success "测试结果: e2e/test-results/test-results.json"

# ============================================================================
# 9. 清理和退出
# ============================================================================

print_info ""
print_info "9️⃣  清理..."

# 如果是我们启动的开发服务器，就杀掉它
if [ ! -z "$DEV_SERVER_PID" ]; then
	print_info "关闭开发服务器..."
	kill $DEV_SERVER_PID 2>/dev/null || true
	print_success "开发服务器已关闭"
fi

# ============================================================================
# 10. 最后的提示
# ============================================================================

print_info ""
print_success "=========================================="
print_success "测试完成！"
print_success "=========================================="
print_info ""
print_info "📁 结果位置："
print_info "   - 截图: e2e/test-results/full-workflow/"
print_info "   - HTML 报告: e2e/test-results/playwright-report/index.html"
print_info "   - JSON 结果: e2e/test-results/test-results.json"
print_info "   - 日志: e2e/test-results/logs/"
print_info ""
print_info "💡 后续步骤："
print_info "   1. 查看截图: open e2e/test-results/full-workflow/"
print_info "   2. 查看详细报告: open e2e/test-results/playwright-report/index.html"
print_info "   3. 将截图分享给 UI 设计师进行审核"
print_info ""

exit $TEST_EXIT_CODE
