/**
 * 前端脱敏：日志离开浏览器前先过一遍（服务端还会兜底再脱敏一次）。
 */
export function maskSensitiveText(text: string): string {
	return String(text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
		// 邀请 token 是一次性入组凭证，只应出现在邀请链接本身；URL/路径/Referer
		// 进入日志前先脱敏（外部评审前端批次：/invitations/<token>、/organization-invitations/<token>）
		.replace(
			/\/(invitations|organization-invitations)\/[^\s/?#'"<>]+/gi,
			"/$1/***",
		)
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
