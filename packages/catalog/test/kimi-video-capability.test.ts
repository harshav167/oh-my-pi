import { describe, expect, it } from "bun:test";
import {
	kimiCodeModelManagerOptions,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "../src/provider-models/openai-compat";

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

// `openai-completions` is the only serializer that emits `video_url`; every
// other API renders "[video omitted]". Both the live discovery path and the
// generated catalog must therefore refuse to advertise video elsewhere, or the
// editor offers a video attach affordance that can never be honoured.
describe("video capability is limited to the serializer that supports it", () => {
	const payloadFor = (providerId: string, modelId: string) => ({
		[providerId]: {
			models: {
				[modelId]: {
					id: modelId,
					name: modelId,
					tool_call: true,
					modalities: { input: ["text", "image", "video"] },
				},
			},
		},
	});

	it("keeps reported video for a descriptor resolved to openai-completions", () => {
		const mapped = mapModelsDevToModels(payloadFor("moonshotai", "kimi-k2.6"), MODELS_DEV_PROVIDER_DESCRIPTORS);
		const model = mapped.find(m => m.id === "kimi-k2.6" && m.api === "openai-completions");
		expect(model).toBeDefined();
		expect(model?.input).toContain("video");
	});

	it("strips reported video for a descriptor resolved to anthropic-messages", () => {
		const mapped = mapModelsDevToModels(payloadFor("anthropic", "claude-opus-5"), MODELS_DEV_PROVIDER_DESCRIPTORS);
		const model = mapped.find(m => m.id === "claude-opus-5");
		expect(model?.api).toBe("anthropic-messages");
		expect(model?.input).toEqual(["text", "image"]);
	});

	it("strips reported video for a descriptor resolved to bedrock-converse-stream", () => {
		const mapped = mapModelsDevToModels(
			payloadFor("amazon-bedrock", "us.amazon.nova-lite-v1:0"),
			MODELS_DEV_PROVIDER_DESCRIPTORS,
		);
		const model = mapped.find(m => m.id === "us.amazon.nova-lite-v1:0");
		expect(model?.api).toBe("bedrock-converse-stream");
		expect(model?.input).toEqual(["text", "image"]);
	});
});
