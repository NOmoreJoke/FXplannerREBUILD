/**
 * 日志脱敏：Token / Cookie / 密码等敏感信息一律替换为 ***。
 * 服务端兜底脱敏（前端 beforeSend 已做过一遍，这里防御纵深）。
 */
export function maskSensitiveText(text: string): string {
	return String(text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
		.replace(
			/(^|[?&\s"'])((?:access_?token|refresh_?token|token|password|secret)=)[^&\s"']+/gi,
			"$1$2***",
		)
		.replace(
			/("(?:authorization|cookie|set-cookie|x-api-key)"\s*:\s*")[^"]*(")/gi,
			"$1***$2",
		)
		.replace(
			/("(?:password|token|accessToken|refreshToken|secret)"\s*:\s*")[^"]*(")/gi,
			"$1***$2",
		);
}

/** 截断超长文本，防止单条日志撑爆文件 */
export function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? text.slice(0, maxLength) : text;
}
