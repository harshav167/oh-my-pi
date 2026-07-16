/**
 * Main-side consult_advisor tool — talk to the live advisor on a persistent thread.
 *
 * Always registered (when the factory can bind a session consult callback). Returns
 * a clear error when no advisor runtime is active. Does not go through IRC.
 */

import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import type { AdvisorConsult } from "../advisor";
import consultAdvisorDescription from "../prompts/tools/consult_advisor.md" with { type: "text" };
import type { ToolSession } from ".";

const DEFAULT_CONSULT_TIMEOUT_MS = 120_000;

const consultAdvisorSchema = type({
	message: type("string").describe(
		"What to ask or tell the advisor. Continues the same conversation thread with that advisor.",
	),
	"advisor?": type("string").describe(
		"Advisor name or slug when multiple advisors are active. Omit when only one is running.",
	),
});

export type ConsultAdvisorParams = typeof consultAdvisorSchema.infer;

export interface ConsultAdvisorDetails {
	advisor: string;
	reply: string;
}

export interface ConsultAdvisorBinding {
	consultAdvisor: AdvisorConsult;
}

export class ConsultAdvisorTool implements AgentTool<typeof consultAdvisorSchema, ConsultAdvisorDetails> {
	readonly name = "consult_advisor";
	readonly label = "Consult Advisor";
	readonly approval = "read" as const;
	readonly description = consultAdvisorDescription;
	readonly parameters = consultAdvisorSchema;

	constructor(private readonly binding: ConsultAdvisorBinding) {}

	static createIf(session: ToolSession): ConsultAdvisorTool | null {
		const consult = session.consultAdvisor;
		if (!consult) return null;
		// SDK binds consultAdvisor only for main sessions, or for subagents when
		// advisor.subagents is true. createIf just reflects that binding.
		return new ConsultAdvisorTool({ consultAdvisor: consult });
	}

	async execute(
		toolCallId: string,
		args: ConsultAdvisorParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ConsultAdvisorDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<ConsultAdvisorDetails>> {
		const message = args.message.trim();
		if (!message) {
			return {
				content: [{ type: "text", text: "consult_advisor requires a non-empty message." }],
				details: { advisor: "", reply: "" },
				isError: true,
			};
		}

		const timeout = AbortSignal.timeout(DEFAULT_CONSULT_TIMEOUT_MS);
		const combined =
			signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);

		try {
			const result = await this.binding.consultAdvisor({
				message,
				advisor: args.advisor?.trim() || undefined,
				toolCallId,
				signal: combined,
			});
			const text = `Advisor (${result.advisor}):\n${result.reply}`;
			return {
				content: [{ type: "text", text }],
				details: { advisor: result.advisor, reply: result.reply },
			};
		} catch (err) {
			const raw = err instanceof Error ? err.message : String(err);
			const timedOut = combined.aborted && timeout.aborted && !signal?.aborted;
			const text = timedOut
				? `consult_advisor timed out after ${DEFAULT_CONSULT_TIMEOUT_MS}ms`
				: raw || "consult_advisor failed";
			return {
				content: [{ type: "text", text }],
				details: { advisor: args.advisor?.trim() || "", reply: "" },
				isError: true,
			};
		}
	}
}
