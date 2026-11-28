import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * 全页 loading（页面级加载态的统一组件）
 *
 * 用法：<PageLoading /> 全屏居中；<PageLoading text="加载项目中" /> 带文案。
 * 局部区域的加载态请直接用 ui/Spinner 或 ui/Skeleton，不要再用本组件。
 */
export function PageLoading({
  text,
  className,
}: {
  text?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-screen flex flex-col items-center justify-center gap-3",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <Spinner className="size-10 text-ink-600" />
      {text && <p className="text-sm text-muted-foreground">{text}</p>}
    </div>
  );
}
