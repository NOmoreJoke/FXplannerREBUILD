import { initDevErrorMonitor } from "@/lib/dev-log/monitor";

// Next.js 客户端 instrumentation：在应用代码之前执行，尽早挂错误采集
initDevErrorMonitor();
