import type { Message } from "../types";

const XAI_GROK_CLI_PROVIDER = "xai-grok-cli";

let processAgentId: string | undefined;
let processSessionFallback: string | undefined;

function getProcessAgentId(): string {
	processAgentId ??= crypto.randomUUID();
	return processAgentId;
}

function getProcessSessionFallback(): string {
	processSessionFallback ??= crypto.randomUUID();
	return processSessionFallback;
}

export function isXaiGrokCliProvider(provider: string): boolean {
	return provider === XAI_GROK_CLI_PROVIDER;
}

/** Count prior assistant turns for x-grok-turn-idx. */
export function countAssistantTurns(messages: readonly Message[] | undefined): number {
	if (!messages) return 0;
	let count = 0;
	for (const message of messages) {
		if (message.role === "assistant") count += 1;
	}
	return count;
}

/**
 * Per-request lifecycle headers for the Grok CLI Build host.
 * Never paste capture UUIDs — generate fresh ids each request / process.
 */
export function buildXaiGrokCliLifecycleHeaders(args: {
	sessionKey?: string;
	modelId: string;
	turnIndex: number;
}): Record<string, string> {
	const sessionKey = args.sessionKey?.trim() || getProcessSessionFallback();
	return {
		"x-grok-session-id": sessionKey,
		"x-grok-conv-id": sessionKey,
		"x-grok-req-id": crypto.randomUUID(),
		"x-grok-agent-id": getProcessAgentId(),
		"x-grok-turn-idx": String(args.turnIndex),
		"x-grok-model-override": args.modelId,
	};
}
