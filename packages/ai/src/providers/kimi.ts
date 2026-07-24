/**
 * Kimi Code provider - wraps OpenAI or Anthropic API based on format setting.
 *
 * Kimi offers both OpenAI-compatible and Anthropic-compatible APIs:
 * - OpenAI: https://api.kimi.com/coding/v1/chat/completions
 * - Anthropic: https://api.kimi.com/coding/v1/messages
 *
 * Each discovered model selects its server-declared protocol; legacy models
 * without protocol metadata retain the Anthropic-compatible default.
 */

import { getKimiCommonHeaders } from "../registry/oauth/kimi";
import type { Api, Context, Model } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type OpenAIAnthropicApiFormat,
	type OpenAIAnthropicShimOptions,
	streamOpenAIAnthropicShim,
} from "./openai-anthropic-shim";

export type KimiApiFormat = OpenAIAnthropicApiFormat;

export interface KimiOptions extends OpenAIAnthropicShimOptions {
	/** Explicit API format override. Defaults to the model's discovered protocol. */
	format?: KimiApiFormat;
}

/**
 * Stream from Kimi Code, routing to either OpenAI or Anthropic API based on format.
 * Returns synchronously like other providers - async header fetching happens internally.
 */
export function streamKimi(
	model: Model<"openai-completions">,
	context: Context,
	options?: KimiOptions,
): AssistantMessageEventStream {
	const hasVideo = context.messages.some(
		message =>
			(message.role === "user" || message.role === "developer") &&
			Array.isArray(message.content) &&
			message.content.some(part => part.type === "video"),
	);
	const resolvedOptions =
		// Video is delivered via `video_url`, which only the OpenAI-format serializer emits.
		// Force it whenever a video is present so the default (often anthropic) can't drop it.
		hasVideo ? { ...options, format: "openai" as const } : options;
	return streamOpenAIAnthropicShim(model, context, resolvedOptions, {
		anthropicBaseUrl: model.baseUrl.replace(/\/v1\/?$/, ""),
		defaultFormat: model.compat.kimiApiFormat ?? "anthropic",
		anthropicThinkingMode: model.compat.thinkingFormat === "kimi" ? "anthropic-adaptive" : undefined,
		forwardCacheOptions: true,
		extraHeaders: getKimiCommonHeaders,
	});
}

/**
 * Check if a model is a Kimi Code model.
 */
export function isKimiModel(model: Model<Api>): boolean {
	return model.provider === "kimi-code";
}
