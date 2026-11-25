import type { Request } from "express";

/**
 * 从请求头提取规范化的 X-Request-Id（N-11 共享纯辅助，供 Controller / Guard 复用）。
 */
export function extractRequestId(
	request: Pick<Request, "headers">,
): string | null {
	const raw = request.headers["x-request-id"];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}
