import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOtpCountdown } from "./use-otp-countdown";

describe("useOtpCountdown（验证码冷却倒计时）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("初始状态为可发送（0 秒，未冷却）", () => {
		const { result } = renderHook(() => useOtpCountdown());

		expect(result.current.seconds).toBe(0);
		expect(result.current.cooling).toBe(false);
	});

	it("start 后进入冷却并逐秒递减，归零后恢复可发送", () => {
		const { result } = renderHook(() => useOtpCountdown());

		act(() => result.current.start(3));
		expect(result.current.cooling).toBe(true);
		expect(result.current.seconds).toBe(3);

		act(() => vi.advanceTimersByTime(1000));
		expect(result.current.seconds).toBe(2);

		act(() => vi.advanceTimersByTime(2000));
		expect(result.current.seconds).toBe(0);
		expect(result.current.cooling).toBe(false);
	});

	it("start 默认 60 秒", () => {
		const { result } = renderHook(() => useOtpCountdown());

		act(() => result.current.start());

		expect(result.current.seconds).toBe(60);
	});

	it("reset 立即归零", () => {
		const { result } = renderHook(() => useOtpCountdown());

		act(() => result.current.start(30));
		expect(result.current.cooling).toBe(true);

		act(() => result.current.reset());
		expect(result.current.seconds).toBe(0);
		expect(result.current.cooling).toBe(false);
	});

	it("倒计时不会减到负数", () => {
		const { result } = renderHook(() => useOtpCountdown());

		act(() => result.current.start(1));
		act(() => vi.advanceTimersByTime(10_000));

		expect(result.current.seconds).toBe(0);
	});
});
