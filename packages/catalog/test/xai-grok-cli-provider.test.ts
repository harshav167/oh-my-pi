import { describe, expect, it, vi } from "bun:test";
import {
	getCatalogProviderEntry,
	providerAuthRequiresOAuth,
	resolveProviderAuthId,
} from "@oh-my-pi/pi-catalog/provider-models";
import { xaiGrokCliModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("xai-grok-cli provider catalog", () => {
	it("declares OAuth-only credential delegation to xai-oauth", () => {
		const entry = getCatalogProviderEntry("xai-grok-cli");
		expect(entry).toBeDefined();
		expect(entry!.authProvider).toBe("xai-oauth");
		expect(entry!.authRequiresOAuth).toBe(true);
		expect(entry!.catalogDiscovery).toBeUndefined();
		expect(entry!.defaultModel).toBe("grok-4.5");
		expect(resolveProviderAuthId("xai-grok-cli")).toBe("xai-oauth");
		expect(providerAuthRequiresOAuth("xai-grok-cli")).toBe(true);
		expect(resolveProviderAuthId("xai-oauth")).toBe("xai-oauth");
		expect(providerAuthRequiresOAuth("xai-oauth")).toBe(false);
	});

	it("discovers Build models with fingerprint headers and Build compat", async () => {
		const seen: { url: string; headers: Record<string, string> }[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			const headers: Record<string, string> = {};
			const raw = init?.headers;
			if (raw && typeof raw === "object" && !(raw instanceof Headers)) {
				for (const [k, v] of Object.entries(raw as Record<string, string>)) {
					headers[k.toLowerCase()] = v;
				}
			} else if (raw instanceof Headers) {
				raw.forEach((v, k) => {
					headers[k.toLowerCase()] = v;
				});
			}
			seen.push({ url, headers });
			return new Response(
				JSON.stringify({
					data: [
						{ id: "grok-4.5", object: "model" },
						{ id: "grok-composer-2.5-fast", object: "model" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const options = xaiGrokCliModelManagerOptions({ apiKey: "test-oauth-access", fetch: fetchMock });
		expect(options.staticModels).toEqual([]);
		const models = await options.fetchDynamicModels?.();
		expect(models).toBeDefined();
		expect(models!.map(m => m.id).sort()).toEqual(["grok-4.5", "grok-composer-2.5-fast"]);

		const discovery = seen[0]!;
		expect(discovery.url).toContain("cli-chat-proxy.grok.com");
		expect(discovery.headers["x-xai-token-auth"]).toBe("xai-grok-cli");
		expect(discovery.headers["user-agent"]).toContain("grok-pager");

		const grok45 = models!.find(m => m.id === "grok-4.5")!;
		expect(grok45.provider).toBe("xai-grok-cli");
		expect(grok45.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
		expect(grok45.reasoning).toBe(true);
		expect(grok45.contextWindow).toBe(500_000);
		expect(grok45.maxTokens).toBe(500_000);
		expect(grok45.name).toBe("Grok 4.5");
		expect(grok45.compat?.includeEncryptedReasoning).toBe(true);
		expect(grok45.compat?.filterReasoningHistory).toBe(false);
		expect(grok45.headers?.["x-xai-token-auth"]).toBe("xai-grok-cli");

		const composer = models!.find(m => m.id === "grok-composer-2.5-fast")!;
		expect(composer.reasoning).toBe(false);
		expect(composer.input).toEqual(["text"]);
		expect(composer.contextWindow).toBe(200_000);
		expect(composer.name).toBe("Grok Composer 2.5 Fast");
	});

	it("has no dynamic fetch without apiKey", () => {
		const options = xaiGrokCliModelManagerOptions({});
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.staticModels).toEqual([]);
	});
});
