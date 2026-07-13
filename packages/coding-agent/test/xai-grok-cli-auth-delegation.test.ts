import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as oauth from "@oh-my-pi/pi-ai/oauth";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function cliModel(): Model {
	return {
		id: "grok-4.5",
		name: "Grok 4.5",
		provider: "xai-grok-cli",
		api: "openai-responses",
		baseUrl: "https://cli-chat-proxy.grok.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 64_000,
	} as Model;
}

describe("xai-grok-cli auth delegation", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-xai-grok-cli-auth-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => credential);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	test("OAuth on xai-oauth unlocks xai-grok-cli and returns access token", async () => {
		await authStorage.set("xai-oauth", {
			type: "oauth",
			access: "super-grok-access",
			refresh: "super-grok-refresh",
			expires: Date.now() + 3_600_000,
		});

		expect(modelRegistry.hasConfiguredAuth(cliModel())).toBe(true);
		expect(await modelRegistry.getApiKey(cliModel(), "sess-1")).toBe("super-grok-access");
		expect(await modelRegistry.getApiKeyForProvider("xai-grok-cli", "sess-1")).toBe("super-grok-access");
		expect(modelRegistry.isUsingOAuth(cliModel())).toBe(true);
	});

	test("API-key-only xai-oauth does not unlock xai-grok-cli", async () => {
		await authStorage.set("xai-oauth", {
			type: "api_key",
			key: "sk-not-oauth",
		});
		authStorage.setRuntimeApiKey("xai-oauth", "runtime-key");

		expect(authStorage.hasAuth("xai-oauth")).toBe(true);
		expect(authStorage.hasOAuth("xai-oauth")).toBe(false);
		expect(modelRegistry.hasConfiguredAuth(cliModel())).toBe(false);
		expect(await modelRegistry.getApiKey(cliModel(), "sess-2")).toBeUndefined();
		expect(await modelRegistry.getApiKeyForProvider("xai-grok-cli", "sess-2")).toBeUndefined();
	});

	test("resolver rotates credentials under xai-oauth", async () => {
		await authStorage.set("xai-oauth", [
			{
				type: "oauth",
				access: "access-a",
				refresh: "refresh-a",
				expires: Date.now() + 3_600_000,
				accountId: "acct-a",
			},
			{
				type: "oauth",
				access: "access-b",
				refresh: "refresh-b",
				expires: Date.now() + 3_600_000,
				accountId: "acct-b",
			},
		]);

		const rotateSpy = vi.spyOn(authStorage, "rotateSessionCredential");
		const model = cliModel();
		const resolver = modelRegistry.resolver(model, "sess-rotate");
		const first = await resolver({ lastChance: false, error: undefined });
		expect(first).toBeTruthy();

		await resolver({
			lastChance: true,
			error: new Error("401 unauthorized"),
			previousKey: first,
		});
		expect(rotateSpy).toHaveBeenCalled();
		const rotateProvider = rotateSpy.mock.calls[0]?.[0];
		expect(rotateProvider).toBe("xai-oauth");
		const rotateOptions = rotateSpy.mock.calls[0]?.[2];
		expect(rotateOptions?.baseUrl).toBe(model.baseUrl);
		expect(rotateOptions?.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
	});

	test("getApiKeyForProvider refreshes expired SuperGrok OAuth for xai-grok-cli", async () => {
		await authStorage.set("xai-oauth", {
			type: "oauth",
			access: "stale-access",
			refresh: "refresh-token",
			expires: Date.now() - 60_000,
		});
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => ({
			...credential,
			access: "refreshed-access",
			refresh: credential.refresh,
			expires: Date.now() + 3_600_000,
		}));
		expect(await modelRegistry.getApiKeyForProvider("xai-grok-cli", "sess-expired")).toBe("refreshed-access");
	});

	test("online discovery refreshes expired SuperGrok OAuth before Build /v1/models", async () => {
		await authStorage.set("xai-oauth", {
			type: "oauth",
			access: "stale-access",
			refresh: "refresh-token",
			expires: Date.now() - 60_000,
		});

		const refreshSpy = vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => ({
			...credential,
			access: "refreshed-access",
			refresh: credential.refresh,
			expires: Date.now() + 3_600_000,
		}));

		const authHeaders: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("cli-chat-proxy.grok.com") && url.includes("/models")) {
				const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
				authHeaders.push(headers.get("authorization") ?? "");
				return new Response(JSON.stringify({ data: [{ id: "grok-4.5", object: "model" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
		});

		const onlineRegistry = new ModelRegistry(authStorage, undefined, {
			fetch: fetchMock as unknown as typeof fetch,
		});
		const refreshCallsBefore = refreshSpy.mock.calls.length;
		await onlineRegistry.refresh("online");

		expect(refreshSpy.mock.calls.length).toBeGreaterThan(refreshCallsBefore);
		expect(authHeaders.some(h => h === "Bearer refreshed-access")).toBe(true);
		expect(authHeaders.every(h => h !== "Bearer stale-access")).toBe(true);
		const discovered = onlineRegistry.find("xai-grok-cli", "grok-4.5");
		expect(discovered).toBeDefined();
		expect(discovered!.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
	});
});
