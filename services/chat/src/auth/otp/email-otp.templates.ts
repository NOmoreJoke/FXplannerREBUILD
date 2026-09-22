/**
 * 验证码邮件模板
 *
 * 只负责纯函数渲染：输入验证码 → 输出 HTML 字符串。
 * 不依赖任何服务/配置，便于单测。
 */

export const VERIFY_CODE_SUBJECT = "【FXPlanner】验证码";

/** HTML 转义（防御性：验证码为纯数字，但保持规范，防止未来模板变量注入） */
export function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** 渲染验证码邮件 HTML */
export function renderVerifyCodeHtml(code: string): string {
	const safeCode = escapeHtml(code);
	return `<!doctype html>
<html lang="zh-CN">
  <body style="margin: 0; padding: 0; background: #f5f6f8; font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;">
    <div style="max-width: 480px; margin: 24px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.06);">
      <div style="background: #2563eb; padding: 24px 28px;">
        <h1 style="margin: 0; color: #ffffff; font-size: 20px;">FXPlanner 验证码</h1>
      </div>
      <div style="padding: 32px 28px;">
        <p style="margin: 0 0 8px; color: #333; font-size: 15px;">您好：</p>
        <p style="margin: 0 0 20px; color: #333; font-size: 15px;">您正在进行登录操作，本次验证码为：</p>
        <div style="margin: 0 0 24px; text-align: center;">
          <span style="display: inline-block; padding: 12px 28px; background: #f3f4f6; border-radius: 8px; font-size: 28px; font-weight: 700; letter-spacing: 8px; color: #111827;">${safeCode}</span>
        </div>
        <p style="margin: 0 0 6px; color: #888; font-size: 13px;">验证码 <b>10 分钟</b> 内有效，请勿将验证码泄露给他人。</p>
        <p style="margin: 0; color: #aaa; font-size: 12px;">如果您没有请求此验证码，请忽略本邮件，并检查您的账号安全。</p>
      </div>
      <div style="background: #f9fafb; padding: 16px 28px;">
        <p style="margin: 0; color: #9ca3af; font-size: 12px;">本邮件由 FXPlanner 系统自动发送，请勿直接回复。FXPlanner 不会以任何形式向您索要验证码。</p>
      </div>
    </div>
  </body>
</html>
`;
}
