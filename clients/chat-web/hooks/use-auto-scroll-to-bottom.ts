import { useEffect, useRef, type RefObject } from "react";

/**
 * 列表内容变化时自动滚动到底部锚点（受控 DOM 副作用 hook）。
 */
export function useAutoScrollToBottom<T extends HTMLElement>(
	scrollKey: string | number,
): RefObject<T | null> {
	const bottomRef = useRef<T | null>(null);

	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [scrollKey]);

	return bottomRef;
}
