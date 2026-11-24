/**
 * 日志脱敏：Token / Cookie / 密码等敏感信息一律替换为 ***。
 * 服务端兜底脱敏（前端 beforeSend 已做过一遍，这里防御纵深）。
 *
 * 邀请规则与 clients/chat-web/lib/dev-log/mask.ts 保持一致，改一处须同步另一处
 * （评审 R2-I12：此前服务端完全没有邀请规则——前端只要漏过一处，一次性邀请 token
 * 就明文落盘并经 GET /frontend-log 暴露）。
 */
export function maskSensitiveText(text: string): string {
	return String(text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer ***")
		// 邀请 token 是一次性入组凭证，只应出现在邀请链接本身。两种形态都要脱敏：
		// ① 路径明文：/invitations/<token>、/api/organization-invitations/<token>/accept。
		//    字符集排除反斜杠：上报体是「JSON 里套 JSON 字符串」，token 后面紧跟的是 \"，
		//    不排除会把它一起吞掉，留下未转义的引号把内层 JSON 撑坏
		.replace(
			/\/(invitations|organization-invitations)\/[^\s/?#'"<>\\]+/gi,
			"/$1/***",
		)
		// ② URL 编码态：登录页 / 向导的回跳参数 /login?redirect=%2Finvitations%2F<token>。
		//    斜杠的百分号本身也可能被再编码（%252F、%25252F…）：redirect 参数被整体
		//    再编码一次就会出现（评审 R3-I05），(%(?:25)*2f) 覆盖任意层数
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

/** 截断超长文本，防止单条日志撑爆文件 */
export function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? text.slice(0, maxLength) : text;
}
