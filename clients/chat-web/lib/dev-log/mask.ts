/**
 * 前端脱敏：日志离开浏览器前先过一遍（服务端还会兜底再脱敏一次）。
 *
 * 邀请规则与 packages/dev-log-server/src/mask.ts 保持一致，改一处须同步另一处。
 */
export function maskSensitiveText(text: string): string {
	return String(text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
		// 邀请 token 是一次性入组凭证，只应出现在邀请链接本身；URL/路径/Referer
		// 进入日志前先脱敏（外部评审前端批次：/invitations/<token>、/organization-invitations/<token>）。
		// 两种形态都要覆盖（评审 R2-I12）：
		// ① 路径明文：/invitations/<token>、/api/organization-invitations/<token>/accept。
		//    字符集必须排除反斜杠：JSON 转义串里 token 后面紧跟的是 \"，不排除会把
		//    反斜杠一起吞掉，留下一个未转义的引号把整段 JSON 撑坏
		.replace(
			/\/(invitations|organization-invitations)\/[^\s/?#'"<>\\]+/gi,
			"/$1/***",
		)
		// ② URL 编码态：登录页 / 向导的回跳参数 /login?redirect=%2Finvitations%2F<token>
		//    （此前只匹配明文斜杠，编码态的 token 原样落盘）。斜杠的百分号本身也可能被
		//    再编码（%252F、%25252F…）：redirect 参数被整体再编码一次就会出现
		//    （评审 R3-I05），(%(?:25)*2f) 覆盖任意层数
		.replace(
			/(%(?:25)*2f)(invitations|organization-invitations)(%(?:25)*2f)[^\s%&?#'"<>\\]+/gi,
			"$1$2$3***",
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
