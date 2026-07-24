import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { NON_VIDEO_PLACEHOLDER } from "@oh-my-pi/pi-ai/providers/vision-guard";
import type { Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ResolvedOpenAICompat } from "@oh-my-pi/pi-catalog/types";

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsMultipleSystemMessages: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	supportsToolChoice: true,
	supportsForcedToolChoice: true,
	supportsNamedToolChoice: true,
	disableReasoningOnForcedToolChoice: false,
	disableReasoningOnToolChoice: false,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresMistralToolIds: false,
	thinkingFormat: "openai",
	reasoningDisableMode: "lowest-effort",
	omitReasoningEffort: false,
	includeEncryptedReasoning: true,
	filterReasoningHistory: false,
	reasoningContentField: "reasoning_content",
	requiresReasoningContentForToolCalls: false,
	requiresReasoningContentForAllAssistantTurns: false,
	allowsSyntheticReasoningContentForToolCalls: true,
	replayReasoningContent: false,
	qwenPreserveThinking: false,
	requiresAssistantContentForToolCalls: false,
	openRouterRouting: {},
	vercelGatewayRouting: {},
	extraBody: {},
	supportsStrictMode: true,
	toolStrictMode: "none",
	supportsReasoningParams: true,
	supportsSamplingParams: true,
	alwaysSendMaxTokens: false,
	isOpenRouterHost: false,
	isVercelGatewayHost: false,
	wireModelIdMode: "raw",
	stripDeepseekSpecialTokens: false,
	reasoningDeltasMayBeCumulative: false,
	emptyLengthFinishIsContextError: false,
	usesOpenAIToolCallIdLimit: false,
	dropThinkingWhenReasoningEffort: false,
} as ResolvedOpenAICompat;

function videoModel(input: ("text" | "image" | "video")[]) {
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
	});
}

const videoContext: Context = {
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: "what is this video about?" },
				{ type: "video", mimeType: "video/mp4", data: "dmlkZW8=" },
			],
			timestamp: 1,
		},
	],
};

describe("openai-completions convertMessages video", () => {
	it("serializes native video as an inline video_url data URI for a video-capable model", () => {
		const messages = convertMessages(videoModel(["text", "image", "video"]), videoContext, compat);
		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this video about?" },
					{ type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
				],
			},
		]);
	});

	it("omits video with a placeholder for a model without native video support", () => {
		const messages = convertMessages(videoModel(["text", "image"]), videoContext, compat);
		expect(messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is this video about?" },
					{ type: "text", text: NON_VIDEO_PLACEHOLDER },
				],
			},
		]);
	});
});
