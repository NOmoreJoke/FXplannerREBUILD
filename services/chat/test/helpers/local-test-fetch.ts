/**
 * 接口测试专用的本地 fetch（supertest 无法覆盖的场景：SSE 流中断、手动端口监听）。
 *
 * 与 e2e/helpers/api-url.ts 的 localFetch 同款「同函数内校验 + fetch」形态
 * （services/chat 不能跨包 import e2e/，各自持有一份；语义保持一致）：
 * 仅允许 http/https 与本地回环地址。测试基建按设计只打本机起的 app 实例，
 * 不构成生产 SSRF 面；生产代码请勿模仿（生产侧应拒绝环回/私网，方向与此相反）。
 * 误读治理背景见 docs/handoff/MIMOSA-GATE-20261105.md。
 */
export async function localTestFetch(
	rawUrl: string,
	init?: RequestInit,
): Promise<Response> {
	const url = new URL(rawUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`接口测试仅允许 http/https 协议：${url.protocol}`);
	}
	const host = url.hostname;
	if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
		throw new Error(`接口测试仅允许本地回环地址，收到：${host}`);
	}
	return fetch(url.toString(), init);
}
