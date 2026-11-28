import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SchedulePreviewCard } from "./schedule-preview-card";

describe("SchedulePreviewCard（动态批数与缩批提示）", () => {
	it("3 批、2 批缩批与未就绪空态各自展示准确文案", () => {
		const { rerender } = render(
			<SchedulePreviewCard
				installments={[
					{ seq: 1, amount: "1000.0000", scheduledAt: "2026-12-01T00:00:00.000Z" },
					{ seq: 2, amount: "1000.0000", scheduledAt: "2026-12-05T00:00:00.000Z" },
					{ seq: 3, amount: "1000.0000", scheduledAt: "2026-12-10T00:00:00.000Z" },
				]}
				latestPrepDate="2026-12-10T00:00:00.000Z"
				isPreviewing={false}
				previewError={null}
				targetCurrency="USD"
			/>,
		);
		expect(screen.getByText(/拆分为 3 批/)).toBeTruthy();

		rerender(
			<SchedulePreviewCard
				installments={[
					{ seq: 1, amount: "1500.0000", scheduledAt: "2026-12-01T00:00:00.000Z" },
					{ seq: 2, amount: "1500.0000", scheduledAt: "2026-12-02T00:00:00.000Z" },
				]}
				latestPrepDate="2026-12-02T00:00:00.000Z"
				isPreviewing={false}
				previewError={null}
				targetCurrency="USD"
			/>,
		);
		expect(screen.getByText(/已按规则自动缩减为 2 批/)).toBeTruthy();

		rerender(
			<SchedulePreviewCard
				installments={[]}
				latestPrepDate={null}
				isPreviewing={false}
				previewError={null}
				targetCurrency="USD"
			/>,
		);
		expect(screen.getByText(/填写完整目标信息后，将自动生成分批排期预览/)).toBeTruthy();
	});
});
