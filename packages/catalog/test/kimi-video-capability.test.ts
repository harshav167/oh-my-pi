import { describe, expect, it } from "bun:test";
import { kimiCodeModelManagerOptions } from "../src/provider-models/openai-compat";

function fakeModelsFetch(ids: string[]): typeof fetch {
	return (async () =>
		new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as unknown as typeof fetch;
}

describe("kimiCodeModelManagerOptions video capability", () => {
	it("resolves kimi-code/k3 with native video input", async () => {
		const options = kimiCodeModelManagerOptions({ apiKey: "test", fetch: fakeModelsFetch(["k3"]) });
		const models = await options.fetchDynamicModels?.();
		const k3 = models?.find(m => m.id === "k3");
		expect(k3).toBeDefined();
		expect(k3?.input).toEqual(["text", "image", "video"]);
	});

	it("resolves kimi-code/kimi-for-coding (K2.7-code) with native video input", async () => {
		const options = kimiCodeModelManagerOptions({
			apiKey: "test",
			fetch: fakeModelsFetch(["kimi-for-coding", "kimi-for-coding-highspeed"]),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models?.find(m => m.id === "kimi-for-coding")?.input).toContain("video");
		expect(models?.find(m => m.id === "kimi-for-coding-highspeed")?.input).toContain("video");
	});

	it("keeps a non-video Kimi id image-only", async () => {
		const options = kimiCodeModelManagerOptions({ apiKey: "test", fetch: fakeModelsFetch(["kimi-k2.5"]) });
		const models = await options.fetchDynamicModels?.();
		const k25 = models?.find(m => m.id === "kimi-k2.5");
		expect(k25?.input).toEqual(["text", "image"]);
	});
});
