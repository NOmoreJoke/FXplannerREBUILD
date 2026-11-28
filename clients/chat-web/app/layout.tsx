import "./globals.css";
import localFont from "next/font/local";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ReactQueryProvider } from "@/lib/react-query-provider";

const playfairDisplay = localFont({
	src: "../public/fonts/playfair-display-latin-wght-normal.woff2",
	variable: "--font-playfair",
	weight: "400 900",
	style: "normal",
	display: "swap",
	// 中文衬线按 OS 优雅降级，跨平台字重与兜底策略见 design-harness/foundations/typography.md
	fallback: ["Songti SC", "STSong", "Source Han Serif SC", "Noto Serif CJK SC", "SimSun", "serif"],
});

export const metadata = {
	title: "FXPlanner",
	description: "FXPlanner 换汇备款规划与账本工作台",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	// suppressHydrationWarning：浏览器扩展（如 Bybit Wallet）会在 hydration 前向 <html> 注入属性，抑制该标签的属性不匹配警告
	return (
		<html
			lang="zh"
			className={cn(playfairDisplay.variable, "font-sans")}
			suppressHydrationWarning
		>
			<body>
				<ReactQueryProvider>
					<TooltipProvider>{children}</TooltipProvider>
				</ReactQueryProvider>
				<Toaster />
			</body>
		</html>
	);
}
