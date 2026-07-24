import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import type { Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function k3(input: ("text" | "image" | "video")[]): Model<"openai-completions"> {
	return buildModel({
		id: "k3",
		name: "K3",
		api: "openai-completions",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.com/coding/v1",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
	}) as Model<"openai-completions">;
}

describe("video input capability survives the config → model pipeline", () => {
	it('accepts a model override declaring native video input (regression: schema rejected "video")', () => {
		const out = ModelsConfigSchema({
			providers: { "kimi-code": { modelOverrides: { k3: { input: ["text", "image", "video"] } } } },
		});
		expect(out).not.toBeInstanceOf(Error);
		const parsed = out as { providers: Record<string, { modelOverrides: Record<string, { input: string[] }> }> };
		expect(parsed.providers["kimi-code"].modelOverrides.k3.input).toEqual(["text", "image", "video"]);
	});

	describe("discovery merge", () => {
		let tempDir: TempDir;
		beforeEach(() => {
			tempDir = TempDir.createSync("@video-input-merge-");
		});
		afterEach(async () => {
			await tempDir.remove().catch(() => {});
		});

		it("preserves video when a dynamic K3 (text,image,video) merges over a static K3 (text,image)", async () => {
			const result = await resolveProviderModels(
				{
					providerId: "kimi-code",
					staticModels: [k3(["text", "image"]) as ModelSpec<"openai-completions">],
					fetchDynamicModels: async () => [k3(["text", "image", "video"]) as ModelSpec<"openai-completions">],
					cacheDbPath: path.join(tempDir.path(), "cache.sqlite"),
				},
				"online",
			);
			const merged = result.models.find(m => m.id === "k3");
			expect(merged).toBeDefined();
			expect(merged?.input).toContain("video");
		});

		it("applies a kimi-code/k3 input override with video through ModelRegistry", async () => {
			const yml = path.join(tempDir.path(), "models.yml");
			await Bun.write(
				yml,
				"providers:\n  kimi-code:\n    modelOverrides:\n      k3:\n        input: [text, image, video]\n",
			);
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			try {
				const registry = new ModelRegistry(authStorage, yml);
				const k3Model = registry.find("kimi-code", "k3");
				expect(k3Model).toBeDefined();
				expect(k3Model?.input).toContain("video");
			} finally {
				authStorage.close();
			}
		});

		it("resolves bundled kimi-code/k3 with native video by default (no override)", async () => {
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			try {
				const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
				const k3Model = registry.find("kimi-code", "k3");
				expect(k3Model).toBeDefined();
				expect(k3Model?.input).toContain("video");
			} finally {
				authStorage.close();
			}
		});
	});
});
