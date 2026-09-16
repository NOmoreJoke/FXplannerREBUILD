import type { Metadata } from "next";

/**
 * 设置占位页
 *
 * 认证守卫在 (protected)/layout.tsx（勿在此重复）。
 * 功能尚未实现，仅提供导航落点，避免侧边栏死链；后续实现时替换本文件。
 */
export const metadata: Metadata = {
	title: "设置 - FXPlanner",
};

export default function SettingsPage() {
	return (
		<div className="mx-auto max-w-5xl px-8 py-6">
			<header className="mb-6">
				<h1 className="text-xl font-bold text-foreground">设置</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					管理账户偏好与本位币设置。
				</p>
			</header>

			<div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-white px-8 py-16 text-center">
				<h2 className="text-base font-bold text-foreground">功能开发中</h2>
				<p className="mt-2 max-w-md text-sm text-muted-foreground">
					设置功能正在建设中，敬请期待。
				</p>
			</div>
		</div>
	);
}
