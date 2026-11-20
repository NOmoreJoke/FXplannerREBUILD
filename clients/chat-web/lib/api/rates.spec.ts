import { afterEach, expect, it, vi } from "vitest";
import type { paths } from "@/lib/api/schema.gen";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("历史报价的生成契约保留响应包装，ratesApi 只返回 data", async () => {
	vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://127.0.0.1/api");

	const envelope = {
		success: true,
		message: "历史汇率查询成功",
		data: {
			base: "USD",
			target: "TWD",
			period: 7,
			data_points: [
				{ date: "2026-11-19", rate: "0.21", source: "frankfurter-v2-reference" },
			],
			current_rate: "0.21",
		},
	} satisfies paths["/api/rates/history"]["get"]["responses"][200]["content"]["application/json"];
	const fetchMock = vi.fn(async () => Response.json(envelope));
	vi.stubGlobal("fetch", fetchMock);

	const { ratesApi } = await import("@/lib/api/rates");
	await expect(ratesApi.history("USD", "TWD", 7)).resolves.toEqual(envelope.data);
	expect(fetchMock).toHaveBeenCalledWith(
		"http://127.0.0.1/api/rates/history?base=USD&target=TWD&period=7",
		expect.objectContaining({ method: "GET" }),
	);
});
