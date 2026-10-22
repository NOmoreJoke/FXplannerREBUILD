/**
 * E2E 后端地址解析与 URL 拼接（唯一入口，供各 spec 与造数 helper 复用）。
 *
 * 安全约束：仅允许 http/https 协议且不携带用户名/密码的地址；
 * path 只允许以 / 开头的相对路径，禁止绝对或协议相对 URL 注入外部主机。
 */

/** 解析后端基地址：env 未设置时使用各调用方声明的默认本地测试地址 */
export function resolveApiBase(raw: string | undefined, fallback: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw ?? fallback);
	} catch {
		throw new Error(`API 地址不是合法 URL：${raw ?? fallback}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`API 地址仅允许 http/https 协议：${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error("API 地址不允许携带用户名/密码");
	}
	return parsed.toString().replace(/\/+$/, "");
}

/** 拼接基地址与相对路径；path 非法时立即抛错 */
export function buildApiUrl(base: string, path: string): string {
	if (!path.startsWith("/")) {
		throw new Error(`path 必须是以 / 开头的相对路径：${path}`);
	}
	if (path.startsWith("//")) {
		throw new Error(`path 不允许是协议相对 URL：${path}`);
	}
	return `${base}${path}`;
}
