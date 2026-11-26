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

/**
 * E2E 造数/断言专用的本地 fetch（测试链路唯一合法 fetch 出口的默认形态）。
 *
 * E2E 测试基建按设计只打本地开发服务（localhost/127.0.0.1/[::1]），不构成生产
 * SSRF 面；本函数在 fetch 前于**同一函数内**显式校验协议与回环主机，使污点分析
 * 能看到「URL → 校验 → fetch」链路（生产代码请勿模仿——生产侧应拒绝环回/私网
 * 地址，方向与此相反）。裸 `fetch(...)` 一律改走本函数（Mimosa gate 误报治理，
 * 见 docs/handoff/MIMOSA-GATE-20261105.md）。
 */
export async function localFetch(
	rawUrl: string,
	init?: RequestInit,
): Promise<Response> {
	const url = new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`E2E 仅允许 http/https 协议：${url.protocol}`);
	}
	const host = url.hostname;
	if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") {
		throw new Error(`E2E 仅允许本地回环地址（测试基建），收到：${host}`);
	}
	return fetch(url.toString(), init);
}
