import type { CredentialRankingContext, CredentialRankingStrategy } from "../usage";

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Scope SuperGrok OAuth usage blocks by product host.
 *
 * Grok Build (`cli-chat-proxy.grok.com`) and api.x.ai share the same
 * `xai-oauth` credential rows and often the same model id (`grok-4.5`), but
 * they are separate billable products. A Build `402 usage balance exhausted`
 * must not suppress the credential for api.x.ai (and vice versa).
 */
export function xaiOAuthBlockScope(context?: CredentialRankingContext): string | undefined {
	const baseUrl = context?.baseUrl?.trim();
	if (!baseUrl) return undefined;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		if (host === "cli-chat-proxy.grok.com" || host.endsWith(".cli-chat-proxy.grok.com")) {
			return "product:grok-build";
		}
		if (host === "api.x.ai" || host.endsWith(".api.x.ai")) {
			return "product:api-xai";
		}
		return `host:${host}`;
	} catch {
		return undefined;
	}
}

export const xaiOauthRankingStrategy: CredentialRankingStrategy = {
	blockScope: xaiOAuthBlockScope,
	findWindowLimits() {
		return {};
	},
	windowDefaults: {
		primaryMs: FIVE_HOURS_MS,
		secondaryMs: SEVEN_DAYS_MS,
	},
};
