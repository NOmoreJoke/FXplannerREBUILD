import * as Sentry from "@sentry/browser";
import { maskSensitiveText } from "./mask";

function devLogUrl(): string | undefined {
	return process.env.NEXT_PUBLIC_DEV_LOG_URL;
}

/**
 * 仅本地开发启用：NODE_ENV=development 且配置了上报地址。
 * 生产构建中 NEXT_PUBLIC_DEV_LOG_URL 不注入，天然关闭。
 */
export function isDevLogEnabled(): boolean {
	return (
		typeof window !== "undefined" &&
		process.env.NODE_ENV === "development" &&
		Boolean(devLogUrl())
	);
}

/**
 * 用 Sentry SDK 采集浏览器错误（JS 异常 / 未处理 Promise rejection / 面包屑），
 * 通过自定义 transport 转发到本地 dev-log-server，不上报任何第三方。
 */
export function initDevErrorMonitor(): void {
	if (!isDevLogEnabled()) return;

	Sentry.init({
		// dsn 仅为合法格式占位，实际发送已被自定义 transport 接管
		dsn: "https://local@local.ingest.sentry.io/1",
		environment: process.env.NODE_ENV,
		tracesSampleRate: 0,

		// 本地开发尽量多抓：关闭 InboundFilters，
		// 它会误丢控制台求值等无文件名堆栈的错误（判为插件错误）
		integrations: (integrations) =>
			integrations.filter(
				(integration) => integration.name !== "InboundFilters",
			),

		beforeSend(event) {
			if (event.message) {
				event.message = maskSensitiveText(event.message).slice(0, 1000);
			}
			if (event.exception?.values) {
				event.exception.values = event.exception.values.map((item) => ({
					...item,
					value: item.value
						? maskSensitiveText(item.value).slice(0, 1000)
						: item.value,
					stacktrace: item.stacktrace
						? {
								...item.stacktrace,
								frames: item.stacktrace.frames?.slice(-20),
							}
						: item.stacktrace,
				}));
			}
			if (event.extra) {
				try {
					event.extra = JSON.parse(
						maskSensitiveText(JSON.stringify(event.extra)).slice(0, 2000),
					) as typeof event.extra;
				} catch {
					delete event.extra;
				}
			}
			if (event.breadcrumbs) {
				event.breadcrumbs = event.breadcrumbs.slice(-20).map((item) => {
					const next = {
						...item,
						message: item.message
							? maskSensitiveText(item.message).slice(0, 500)
							: item.message,
					};
					// console 面包屑的 arguments 体积极大且无排障价值，剔除
					if (next.category === "console" && next.data) {
						const data = { ...next.data };
						delete data.arguments;
						next.data = data;
					}
					return next;
				});
			}
			return event;
		},

		transport: (options) =>
			Sentry.createTransport(options, async (request) => {
				const body =
					typeof request.body === "string"
						? request.body
						: new TextDecoder().decode(request.body);

				await fetch(devLogUrl() as string, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					keepalive: true,
					body: JSON.stringify({
						source: "sentry-browser",
						pageUrl: window.location.href,
						timestamp: Date.now(),
						envelope: body,
					}),
				}).catch(() => {
					// 本地日志服务未启动时静默失败，不影响页面
				});

				return { statusCode: 200 };
			}),
	});
}

export interface ApiErrorInfo {
	endpoint: string;
	method: string;
	kind: "http" | "network";
	status?: number;
	message?: string;
}

/** 供 lib/api/client.ts 在请求失败时调用（未启用时为空操作） */
export function captureApiError(info: ApiErrorInfo): void {
	if (!isDevLogEnabled()) return;

	Sentry.captureMessage(
		`API Error: ${info.kind === "http" ? info.status : "NETWORK"} ${info.method} ${info.endpoint}`,
		{
			level: "error",
			tags: { type: "api_error" },
			extra: { ...info },
		},
	);
}
