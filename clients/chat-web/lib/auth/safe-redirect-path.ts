/**
 * redirect 参数白名单校验
 *
 * 仅接受站内绝对路径：以单个 `/` 开头且第二个字符不是 `/`。
 * 拒绝外站与协议跳转（`//evil.com`、`https://evil.com` 等，防开放重定向），
 * 不合法时返回 undefined，由调用方兜底到默认路径。
 */
export function safeRedirectPath(
	value: string | null | undefined,
): string | undefined {
	if (!value) return undefined;
	if (!value.startsWith("/")) return undefined;
	if (value.startsWith("//")) return undefined;
	return value;
}
