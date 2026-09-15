import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/**
 * 公开落地页（纯静态服务端组件）
 * 品牌视觉与工作台侧边栏同源：mint 方块 Logo + font-display 字标
 */
export default function HomePage() {
	return (
		<main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-6">
			{/* 顶部 mint 品牌渐变点缀 */}
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-mint-50 to-transparent"
			/>

			<div className="relative flex flex-col items-center text-center">
				{/* Logo：与工作台侧边栏同源 */}
				<div className="mb-8 flex items-center gap-2.5">
					<div className="flex size-10 items-center justify-center rounded-lg bg-mint-700 text-sm font-bold text-white">
						FX
					</div>
					<span className="font-display text-2xl font-semibold text-foreground">
						FXPlanner
					</span>
				</div>

				<h1 className="mb-4 font-display text-4xl font-bold text-foreground sm:text-5xl">
					规划你的换汇工作台
				</h1>
				<p className="mb-10 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
					把换汇从临时决定变成有计划的安排：制定换汇计划、比较多平台兑换路径，在合适的汇率窗口及时收到提醒。
				</p>

				<div className="flex flex-wrap items-center justify-center gap-3">
					<Link href="/register" className={buttonVariants({ size: "lg" })}>
						免费注册
					</Link>
					<Link
						href="/login"
						className={buttonVariants({ variant: "outline", size: "lg" })}
					>
						登录
					</Link>
				</div>

				<p className="mt-8 text-sm text-ink-400">
					换汇计划 · 多平台比价 · 汇率提醒
				</p>
			</div>
		</main>
	);
}
