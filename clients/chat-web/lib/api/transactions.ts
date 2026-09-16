import { apiClient } from "@/lib/api/client";
import type {
	CreateTransactionReq,
	TransactionDto,
} from "@/lib/api/contract";

export const transactionsApi = {
	/**
	 * 创建买入记录（POST /transactions）
	 *
	 * 两种填法三值同送（本金/汇率/到账），服务端做双向自洽校验
	 * （receivedAmountOf(p,r)==q 或 impliedRate(p,q)==r 满足其一）。
	 * 事务内自动建户 + 余额累加 + 落交易记录，任一失败全部回滚。
	 * 失败：400 INVALID_TRANSACTION_PARAMS / ROUND_TO_ZERO / PLAN_CURRENCY_MISMATCH、
	 * 404 PLAN_NOT_FOUND（错误体 { code, message }，由 apiClient 抛 ApiError）。
	 */
	async create(req: CreateTransactionReq): Promise<TransactionDto> {
		return apiClient<TransactionDto>("/transactions", {
			method: "POST",
			body: JSON.stringify(req),
		});
	},

	/**
	 * 交易详情（GET /transactions/:id）
	 *
	 * 仅本人可见：不存在或不属于本人一律 404 TRANSACTION_NOT_FOUND。
	 * 手续费未知时 feeAmount=null、totalCost=null、feeKnown=false。
	 */
	async detail(id: string): Promise<TransactionDto> {
		return apiClient<TransactionDto>(`/transactions/${id}`, {
			method: "GET",
		});
	},
};
