"use client";

import { useCallback, useEffect, useState } from "react";

/** 验证码发送冷却默认时长（秒），与后端限流策略对齐 */
const DEFAULT_COOLDOWN_SECONDS = 60;

/**
 * OTP 验证码发送冷却倒计时
 *
 * - seconds：剩余秒数（0 表示可发送）
 * - cooling：是否冷却中
 * - start(duration?)：开始倒计时，默认 60s
 * - reset()：立即归零（切换渠道 / 修改目标时调用）
 */
export function useOtpCountdown(initialSeconds = 0) {
	const [seconds, setSeconds] = useState(initialSeconds);
	const cooling = seconds > 0;

	useEffect(() => {
		if (!cooling) return undefined;
		const timer = window.setInterval(() => {
			setSeconds((current) => Math.max(current - 1, 0));
		}, 1000);
		return () => window.clearInterval(timer);
	}, [cooling]);

	const start = useCallback(
		(duration: number = DEFAULT_COOLDOWN_SECONDS) => {
			setSeconds(Math.max(duration, 0));
		},
		[],
	);

	const reset = useCallback(() => setSeconds(0), []);

	return { seconds, cooling, start, reset };
}
