import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function HomePage() {
	return (
		<main className="flex min-h-screen flex-col items-center justify-center bg-background">
			<div className="text-center">
				<h1 className="mb-4 font-display text-4xl font-bold text-foreground">
					FXPlanner-new
				</h1>
				<p className="mb-8 text-muted-foreground">
					全栈骨架已就绪，开始构建你的应用
				</p>
				<div className="flex justify-center gap-4">
					<Link href="/login" className={buttonVariants()}>
						登录
					</Link>
					<Link
						href="/register"
						className={buttonVariants({ variant: "outline" })}
					>
						注册
					</Link>
				</div>
			</div>
		</main>
	);
}
