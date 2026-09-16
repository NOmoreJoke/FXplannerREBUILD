import "./globals.css";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ReactQueryProvider } from "@/lib/react-query-provider";

export const metadata = {
	title: "fxplanner-new chat-web",
	description: "monorepo 底座最小 Web 客户端",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	// suppressHydrationWarning：浏览器扩展（如 Bybit Wallet）会在 hydration 前向 <html> 注入属性，抑制该标签的属性不匹配警告
	return (
		<html lang="zh" className={cn("font-sans")} suppressHydrationWarning>
			<body>
				<ReactQueryProvider>
					<TooltipProvider>{children}</TooltipProvider>
				</ReactQueryProvider>
				<Toaster />
			</body>
		</html>
	);
}
