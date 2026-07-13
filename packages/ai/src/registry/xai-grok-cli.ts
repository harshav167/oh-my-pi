import type { ProviderDefinition } from "./types";

/**
 * Grok CLI / Build host picker provider. Models are discovered at runtime from
 * cli-chat-proxy.grok.com. Credentials are not stored under this id — coding-agent
 * and auth-gateway resolve AuthStorage under `xai-oauth` via catalog `authProvider`.
 * Intentionally has no `login` so it does not appear in `/login`.
 */
export const xaiGrokCliProvider = {
	id: "xai-grok-cli",
	name: "xAI Grok CLI (Build)",
} as const satisfies ProviderDefinition;
