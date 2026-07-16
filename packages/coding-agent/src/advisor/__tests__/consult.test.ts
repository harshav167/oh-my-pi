import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { SecretObfuscator } from "../../secrets/obfuscator";
import { type AdvisorAgent, AdvisorRuntime, type AdvisorRuntimeHost, resolveAdvisorDeliveryChannel } from "..";

async function flushMicrotasksUntil(predicate: () => boolean, limit = 20): Promise<void> {
	for (let i = 0; i < limit && !predicate(); i++) {
		await Promise.resolve();
	}
}

describe("consult_advisor contracts", () => {
	describe("resolveAdvisorDeliveryChannel consultInFlight", () => {
		it("downgrades concern/blocker to aside while a consult is in flight", () => {
			for (const severity of ["concern", "blocker"] as const) {
				expect(
					resolveAdvisorDeliveryChannel({
						severity,
						autoResumeSuppressed: false,
						streaming: true,
						aborting: false,
						consultInFlight: true,
					}),
				).toBe("aside");
			}
		});

		it("still steers concern when consult is not in flight", () => {
			expect(
				resolveAdvisorDeliveryChannel({
					severity: "concern",
					autoResumeSuppressed: false,
					streaming: true,
					aborting: false,
					consultInFlight: false,
				}),
			).toBe("steer");
		});
	});

	describe("AdvisorRuntime.consult", () => {
		function makeHost(messages: AgentMessage[], hooks?: Partial<AdvisorRuntimeHost>): AdvisorRuntimeHost {
			return {
				snapshotMessages: () => messages,
				enqueueAdvice: () => {},
				...hooks,
			};
		}

		it("serializes consult behind an in-flight passive review", async () => {
			const promptInputs: string[] = [];
			const { promise: firstPromptStarted, resolve: startFirstPrompt } = Promise.withResolvers<void>();
			const { promise: finishFirstPrompt, resolve: releaseFirstPrompt } = Promise.withResolvers<void>();
			let promptCalls = 0;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					promptCalls++;
					if (promptCalls === 1) {
						startFirstPrompt();
						await finishFirstPrompt;
						return;
					}
					// Consult prompt only — append the reply after this prompt starts.
					agent.state.messages.push({
						role: "user",
						content: input,
						timestamp: Date.now(),
					} as AgentMessage);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "Because the write races the reader." }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [{ role: "user", content: "primary turn", timestamp: 1 } as AgentMessage];
			const runtime = new AdvisorRuntime(agent, makeHost(messages));

			runtime.onTurnEnd(messages);
			await firstPromptStarted;
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("### Session update");

			let consultResolved = false;
			const consultPromise = runtime.consult({ message: "Why is this a concern?" }).then(result => {
				consultResolved = true;
				return result;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(promptInputs).toHaveLength(1);
			expect(consultResolved).toBe(false);

			releaseFirstPrompt();
			const result = await consultPromise;
			expect(promptInputs.length).toBeGreaterThanOrEqual(2);
			const consultPrompt = promptInputs.find(p => p.includes("### Consultation from primary"));
			expect(consultPrompt).toBeDefined();
			expect(consultPrompt).toContain("Why is this a concern?");
			expect(result.reply).toContain("write races the reader");
		});

		it("returns assistant text on a persistent thread across repeated consults", async () => {
			const promptInputs: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					agent.state.messages.push({
						role: "user",
						content: input,
						timestamp: Date.now(),
					} as AgentMessage);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: `ack: ${promptInputs.length}` }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));

			const first = await runtime.consult({ message: "first question" });
			const second = await runtime.consult({ message: "follow-up assuming first answer" });

			expect(first.reply).toBe("ack: 1");
			expect(second.reply).toBe("ack: 2");
			const userTurns = agent.state.messages.filter(m => m.role === "user");
			expect(userTurns.length).toBe(2);
			expect(promptInputs[0]).toContain("first question");
			expect(promptInputs[1]).toContain("follow-up assuming first answer");
		});

		it("obfuscates secrets in consultation messages before prompting the advisor", async () => {
			const secret = "consult-secret-value";
			const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
			const placeholder = obfuscator.obfuscate(secret);
			const promptInputs: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "redacted" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([], { obfuscator }));

			await runtime.consult({ message: `check ${secret}` });

			expect(promptInputs[0]).toContain(placeholder);
			expect(promptInputs[0]).not.toContain(secret);
		});

		it("forces text-only consultation without mutating advisor tools", async () => {
			const toolChoices: Array<string | undefined> = [];
			const agent: AdvisorAgent = {
				prompt: async (input, options) => {
					toolChoices.push(options?.toolChoice);
					agent.state.messages.push({
						role: "user",
						content: input,
						timestamp: Date.now(),
					} as AgentMessage);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "clarified" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));

			await runtime.consult({ message: "clarify the note" });

			expect(toolChoices).toEqual(["none"]);
		});

		it("strips already-seen consult_advisor tool pairs from passive deltas", async () => {
			const promptInputs: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					if (input.includes("### Consultation from primary")) {
						agent.state.messages.push({
							role: "user",
							content: input,
							timestamp: Date.now(),
						} as AgentMessage);
						agent.state.messages.push({
							role: "assistant",
							content: [{ type: "text", text: "direct consult reply" }],
							timestamp: Date.now(),
						} as AgentMessage);
					}
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [];
			const runtime = new AdvisorRuntime(agent, makeHost(messages));

			const result = await runtime.consult({ message: "explain the blocker" });
			expect(result.reply).toBe("direct consult reply");
			runtime.markConsultToolCallSeen("consult-tc-1");

			messages.push(
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "consult-tc-1",
							name: "consult_advisor",
							arguments: { message: "explain the blocker" },
						},
					],
					timestamp: 10,
				} as unknown as AgentMessage,
				{
					role: "toolResult",
					toolCallId: "consult-tc-1",
					toolName: "consult_advisor",
					content: [{ type: "text", text: "Advisor (default):\ndirect consult reply" }],
					isError: false,
					timestamp: 11,
				} as unknown as AgentMessage,
				{ role: "user", content: "continue after consult", timestamp: 12 } as AgentMessage,
			);

			runtime.onTurnEnd(messages);
			await flushMicrotasksUntil(() => promptInputs.some(p => p.includes("### Session update")));

			const sessionUpdate = promptInputs.find(p => p.includes("### Session update"));
			expect(sessionUpdate).toBeDefined();
			expect(sessionUpdate).not.toContain("consult_advisor");
			expect(sessionUpdate).not.toContain("direct consult reply");
			expect(sessionUpdate).toContain("continue after consult");
		});

		it("strips a result-only consult_advisor delta when the call was already seen", async () => {
			// Real flow: pre-consult catch-up advances lastCount past the in-flight
			// toolCall; later onTurnEnd often receives only the toolResult.
			const promptInputs: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					if (input.includes("### Consultation from primary")) {
						agent.state.messages.push({
							role: "user",
							content: input,
							timestamp: Date.now(),
						} as AgentMessage);
						agent.state.messages.push({
							role: "assistant",
							content: [{ type: "text", text: "consult answer" }],
							timestamp: Date.now(),
						} as AgentMessage);
					}
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "consult-split-1",
							name: "consult_advisor",
							arguments: { message: "why?" },
						},
					],
					timestamp: 1,
				} as unknown as AgentMessage,
			];
			const runtime = new AdvisorRuntime(agent, makeHost(messages));

			// Consult marks the id and catch-up advances lastCount past the toolCall.
			await runtime.consult({ message: "why?", toolCallId: "consult-split-1" });

			// Result arrives alone in a later delta (call already past lastCount).
			messages.push(
				{
					role: "toolResult",
					toolCallId: "consult-split-1",
					toolName: "consult_advisor",
					content: [{ type: "text", text: "Advisor (default):\nconsult answer" }],
					isError: false,
					timestamp: 2,
				} as unknown as AgentMessage,
				{ role: "user", content: "after result only", timestamp: 3 } as AgentMessage,
			);
			runtime.onTurnEnd(messages);
			await flushMicrotasksUntil(() => promptInputs.some(p => p.includes("after result only")));

			const sessionUpdate = promptInputs.find(p => p.includes("after result only"));
			expect(sessionUpdate).toBeDefined();
			expect(sessionUpdate).not.toContain("consult answer");
			expect(sessionUpdate).not.toMatch(/consult_advisor.*consult answer/s);
		});

		it("folds unread primary context into one text-only consult prompt (no agentic preflush)", async () => {
			const promptInputs: string[] = [];
			const toolChoices: Array<string | undefined> = [];
			const agent: AdvisorAgent = {
				prompt: async (input, options) => {
					promptInputs.push(input);
					toolChoices.push(options?.toolChoice);
					agent.state.messages.push({
						role: "user",
						content: input,
						timestamp: Date.now(),
					} as AgentMessage);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "caught up and answered" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{ role: "user", content: "primary work before consult", timestamp: 1 } as AgentMessage,
			];
			const runtime = new AdvisorRuntime(agent, makeHost(messages));

			const result = await runtime.consult({ message: "what did I miss?" });
			expect(result.reply).toBe("caught up and answered");
			// One prompt only — not a separate agentic review then consult.
			expect(promptInputs).toHaveLength(1);
			expect(toolChoices).toEqual(["none"]);
			expect(promptInputs[0]).toContain("### Session update");
			expect(promptInputs[0]).toContain("primary work before consult");
			expect(promptInputs[0]).toContain("### Consultation from primary");
			expect(promptInputs[0]).toContain("what did I miss?");
		});

		it("maintains advisor context and rebuilds a combined consult after re-prime", async () => {
			const promptInputs: string[] = [];
			const maintainedTokens: number[] = [];
			let resetCount = 0;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "re-primed answer" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {
					resetCount++;
					agent.state.messages = [];
				},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{ role: "user", content: "full primary history", timestamp: 1 } as AgentMessage,
			];
			const runtime = new AdvisorRuntime(
				agent,
				makeHost(messages, {
					maintainContext: async tokens => {
						maintainedTokens.push(tokens);
						return true;
					},
				}),
			);

			const result = await runtime.consult({ message: "review after promotion", toolCallId: "consult-maintain-1" });

			expect(maintainedTokens).toHaveLength(1);
			expect(maintainedTokens[0]).toBeGreaterThan(0);
			expect(resetCount).toBe(1);
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("full primary history");
			expect(promptInputs[0]).toContain("review after promotion");
			expect(result.reply).toBe("re-primed answer");
		});

		it("clears seen consult tool ids on reset so re-prime reconstructs from primary", async () => {
			const promptInputs: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
				},
				abort: () => {},
				reset: () => {
					agent.state.messages = [];
				},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "consult-tc-2",
							name: "consult_advisor",
							arguments: { message: "prior consult" },
						},
					],
					timestamp: 1,
				} as unknown as AgentMessage,
				{
					role: "toolResult",
					toolCallId: "consult-tc-2",
					toolName: "consult_advisor",
					content: [{ type: "text", text: "prior reply" }],
					isError: false,
					timestamp: 2,
				} as unknown as AgentMessage,
			];
			const runtime = new AdvisorRuntime(agent, makeHost(messages));
			runtime.markConsultToolCallSeen("consult-tc-2");
			runtime.reset();

			runtime.onTurnEnd(messages);
			await flushMicrotasksUntil(() => promptInputs.length > 0);
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("consult_advisor");
			expect(promptInputs[0]).toContain("prior consult");
			expect(promptInputs[0]).toContain("prior reply");
		});

		it("rejects consult after dispose", async () => {
			const agent: AdvisorAgent = {
				prompt: async () => {},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));
			runtime.dispose();
			await expect(runtime.consult({ message: "hello" })).rejects.toThrow(/disposed/i);
		});

		it("flushes an unprocessed primary snapshot as Session update before consultation", async () => {
			const promptInputs: string[] = [];
			const toolChoices: Array<string | undefined> = [];
			const agent: AdvisorAgent = {
				prompt: async (input, options) => {
					promptInputs.push(input);
					toolChoices.push(options?.toolChoice);
					agent.state.messages.push({
						role: "user",
						content: input,
						timestamp: Date.now(),
					} as AgentMessage);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "caught up" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{ role: "user", content: "primary work before consult", timestamp: 1 } as AgentMessage,
			];
			const runtime = new AdvisorRuntime(agent, makeHost(messages));

			// No onTurnEnd — consult folds unread primary into one text-only prompt.
			const result = await runtime.consult({ message: "what did I miss?" });
			expect(result.reply).toBe("caught up");
			expect(promptInputs).toHaveLength(1);
			expect(toolChoices).toEqual(["none"]);
			expect(promptInputs[0]).toContain("### Session update");
			expect(promptInputs[0]).toContain("primary work before consult");
			expect(promptInputs[0]).toContain("### Consultation from primary");
			expect(promptInputs[0]).toContain("what did I miss?");
		});

		it("does not consult when catch-up fails", async () => {
			const promptInputs: string[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					// Single combined prompt: failure aborts the whole consult.
					throw new Error("catch-up failed");
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{ role: "user", content: "latest primary work", timestamp: 1 } as AgentMessage,
			];
			const runtime = new AdvisorRuntime(agent, makeHost(messages), 0);

			await expect(runtime.consult({ message: "review this" })).rejects.toThrow(/catch-up failed/i);
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("### Session update");
			expect(promptInputs[0]).toContain("### Consultation from primary");

			// Failed consult must not permanently skip the primary delta for later reviews.
			runtime.onTurnEnd(messages);
			await flushMicrotasksUntil(() => promptInputs.length >= 2);
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("### Session update");
			expect(promptInputs[1]).toContain("latest primary work");
			expect(promptInputs[1]).not.toContain("### Consultation from primary");
		});

		it("restores primary-context dedupe after a failed combined consult prompt", async () => {
			const constraint = "Never modify generated files directly.";
			const promptInputs: string[] = [];
			let failNextPrompt = true;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					if (failNextPrompt) {
						failNextPrompt = false;
						throw new Error("consult failed");
					}
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{
					role: "custom",
					customType: "plan-mode-context",
					content: constraint,
					timestamp: 1,
				} as AgentMessage,
			];
			const runtime = new AdvisorRuntime(agent, makeHost(messages), 0);

			await expect(runtime.consult({ message: "review this" })).rejects.toThrow(/consult failed/i);
			runtime.onTurnEnd(messages);
			await flushMicrotasksUntil(() => promptInputs.length >= 2);

			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain(constraint);
			expect(promptInputs[1]).not.toContain("(unchanged — still in effect)");
		});

		it("rejects when cancelled during the combined consult prompt", async () => {
			const promptInputs: string[] = [];
			const { promise: promptStarted, resolve: markPromptStarted } = Promise.withResolvers<void>();
			const { promise: heldPrompt, reject: rejectPrompt } = Promise.withResolvers<void>();
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					markPromptStarted();
					await heldPrompt;
				},
				abort: () => {
					rejectPrompt(new Error("aborted"));
				},
				reset: () => {},
				state: { messages: [] },
			};
			const messages: AgentMessage[] = [
				{ role: "user", content: "latest primary work", timestamp: 1 } as AgentMessage,
			];
			const runtime = new AdvisorRuntime(agent, makeHost(messages), 0);
			const controller = new AbortController();
			const consultPromise = runtime.consult({ message: "review this", signal: controller.signal });
			await promptStarted;

			controller.abort(new Error("caller aborted"));

			await expect(consultPromise).rejects.toThrow(/abort/i);
			expect(promptInputs).toHaveLength(1);
			expect(promptInputs[0]).toContain("### Session update");
			expect(promptInputs[0]).toContain("### Consultation from primary");

			// Cursor restored: later passive review still gets the primary work.
			runtime.onTurnEnd(messages);
			await flushMicrotasksUntil(() => promptInputs.length >= 2);
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("### Session update");
			expect(promptInputs[1]).toContain("latest primary work");
			expect(promptInputs[1]).not.toContain("### Consultation from primary");
		});

		it("runs concurrent consults FIFO with distinct replies", async () => {
			const promptInputs: string[] = [];
			const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers<void>();
			const { promise: releaseFirst, resolve: releaseFirstPrompt } = Promise.withResolvers<void>();
			let consultPromptCount = 0;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					if (!input.includes("### Consultation from primary")) return;
					consultPromptCount++;
					const n = consultPromptCount;
					if (n === 1) {
						markFirstStarted();
						await releaseFirst;
					}
					agent.state.messages.push({
						role: "user",
						content: input,
						timestamp: Date.now(),
					} as AgentMessage);
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: `reply-${n}` }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));

			const first = runtime.consult({ message: "first" });
			await firstStarted;
			const second = runtime.consult({ message: "second" });
			// Second consult must not start its prompt while the first is held.
			await Promise.resolve();
			await Promise.resolve();
			expect(promptInputs.filter(p => p.includes("### Consultation")).length).toBe(1);

			releaseFirstPrompt();
			const [a, b] = await Promise.all([first, second]);
			expect(a.reply).toBe("reply-1");
			expect(b.reply).toBe("reply-2");
			const consultPrompts = promptInputs.filter(p => p.includes("### Consultation"));
			expect(consultPrompts[0]).toContain("first");
			expect(consultPrompts[1]).toContain("second");
		});

		it("rejects a cancelled queued consult before the in-flight consult completes", async () => {
			const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers<void>();
			const { promise: releaseFirst, resolve: releaseFirstPrompt } = Promise.withResolvers<void>();
			const agent: AdvisorAgent = {
				prompt: async input => {
					if (!input.includes("### Consultation from primary")) return;
					markFirstStarted();
					await releaseFirst;
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "first reply" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));
			const first = runtime.consult({ message: "first" });
			await firstStarted;
			const controller = new AbortController();
			const second = runtime.consult({ message: "second", signal: controller.signal });
			let firstSettled = false;
			void first.finally(() => {
				firstSettled = true;
			});

			controller.abort(new Error("caller aborted"));

			await expect(second).rejects.toThrow(/abort/i);
			expect(firstSettled).toBe(false);
			releaseFirstPrompt();
			await first;
		});

		it("rejects an in-flight consult when reset aborts it", async () => {
			const { promise: promptStarted, resolve: markStarted } = Promise.withResolvers<void>();
			const { promise: heldPrompt, reject: rejectInFlight } = Promise.withResolvers<void>();
			const agent: AdvisorAgent = {
				prompt: async () => {
					markStarted();
					await heldPrompt;
				},
				abort: () => {
					rejectInFlight(new Error("advisor reset"));
				},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));
			const consultPromise = runtime.consult({ message: "mid-flight" });
			await promptStarted;
			runtime.reset();
			await expect(consultPromise).rejects.toThrow(/reset|aborted|disposed/i);
		});

		it("rejects both the in-flight and a queued consult when reset fires", async () => {
			const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers<void>();
			const { promise: heldPrompt, reject: rejectInFlight } = Promise.withResolvers<void>();
			const agent: AdvisorAgent = {
				prompt: async () => {
					markFirstStarted();
					await heldPrompt;
				},
				abort: () => {
					rejectInFlight(new Error("advisor reset"));
				},
				reset: () => {},
				state: { messages: [] },
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));
			const first = runtime.consult({ message: "running" });
			await firstStarted;
			const second = runtime.consult({ message: "queued" });
			await Promise.resolve();
			const outcomes = Promise.allSettled([first, second]);
			runtime.reset();
			const [a, b] = await outcomes;
			expect(a.status).toBe("rejected");
			expect(b.status).toBe("rejected");
			if (a.status === "rejected") {
				expect(String(a.reason)).toMatch(/reset|aborted|disposed/i);
			}
			if (b.status === "rejected") {
				expect(String(b.reason)).toMatch(/reset|aborted|disposed/i);
			}
		});

		it("aborts consult when the signal fires and rolls back the failed turn", async () => {
			const { promise: promptStarted, resolve: markStarted } = Promise.withResolvers<void>();
			const { promise: heldPrompt, reject: rejectInFlight } = Promise.withResolvers<void>();
			const messages: AgentMessage[] = [];
			const agent: AdvisorAgent = {
				prompt: async input => {
					messages.push({ role: "user", content: input, timestamp: Date.now() } as AgentMessage);
					markStarted();
					await heldPrompt;
				},
				abort: () => {
					rejectInFlight(new Error("aborted"));
				},
				reset: () => {},
				rollbackTo: count => {
					messages.length = count;
				},
				get state() {
					return { messages };
				},
			};
			const runtime = new AdvisorRuntime(agent, makeHost([]));
			const controller = new AbortController();
			const consultPromise = runtime.consult({ message: "abort me", signal: controller.signal });
			await promptStarted;
			expect(messages.length).toBe(1);
			controller.abort(new Error("caller aborted"));
			await expect(consultPromise).rejects.toThrow(/abort/i);
			// Failed consult turn rolled back.
			expect(messages.length).toBe(0);
		});

		it("re-marks the in-flight consult toolCallId after re-prime so the result is not replayed", async () => {
			const promptInputs: string[] = [];
			let promptCallCount = 0;
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					promptCallCount++;
					agent.state.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "reply" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {
					agent.state.messages = [];
				},
				state: { messages: [] as AgentMessage[] },
			};
			// Primary history initially contains only the active toolCall (no result yet).
			const messages: AgentMessage[] = [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "consult-reprime-1",
							name: "consult_advisor",
							arguments: { message: "in-flight consult" },
						},
					],
					timestamp: 1,
				} as unknown as AgentMessage,
				{ role: "user", content: "later primary turn", timestamp: 2 } as AgentMessage,
			];
			const runtime = new AdvisorRuntime(
				agent,
				makeHost(messages, {
					maintainContext: async () => true,
				}),
			);

			const result = await runtime.consult({ message: "new consult", toolCallId: "consult-reprime-1" });
			expect(result.reply).toBe("reply");
			expect(promptCallCount).toBe(1);
			expect(promptInputs[0]).toContain("later primary turn");
			expect(promptInputs[0]).not.toContain("in-flight consult");

			// Now append the toolResult for the completed consult and trigger a passive review.
			messages.push({
				role: "toolResult",
				toolCallId: "consult-reprime-1",
				toolName: "consult_advisor",
				content: [{ type: "text", text: "in-flight reply" }],
				isError: false,
				timestamp: 3,
			} as unknown as AgentMessage);
			runtime.onTurnEnd(messages);
			await runtime.waitForCatchup(1000, 1);
			// Correct behavior: the consult id was re-marked, so the result-only delta
			// is filtered and no passive review prompt is produced.
			expect(promptInputs).toHaveLength(1);
		});

		it("keeps cursor at zero after re-prime + prompt failure so earlier history is replayed", async () => {
			const promptInputs: string[] = [];
			let promptCallCount = 0;
			const agentState = { messages: [] as AgentMessage[] };
			const agent: AdvisorAgent = {
				prompt: async input => {
					promptInputs.push(input);
					promptCallCount++;
					if (promptCallCount === 1) {
						throw new Error("prompt failed");
					}
					agentState.messages.push({
						role: "assistant",
						content: [{ type: "text", text: "review reply" }],
						timestamp: Date.now(),
					} as AgentMessage);
				},
				abort: () => {},
				reset: () => {
					agentState.messages = [];
				},
				rollbackTo: count => {
					agentState.messages.length = count;
				},
				get state() {
					return agentState;
				},
			};
			const messages: AgentMessage[] = [
				{ role: "user", content: "early primary history", timestamp: 1 } as AgentMessage,
				{ role: "user", content: "recent primary turn", timestamp: 2 } as AgentMessage,
			];
			const runtime = new AdvisorRuntime(
				agent,
				makeHost(messages, {
					maintainContext: async () => true,
				}),
			);
			// Seed past the first message so cursor is non-zero; without the fix the
			// catch block would restore the pre-maintenance cursor and skip early history.
			runtime.seedTo(1);

			await expect(runtime.consult({ message: "failing consult" })).rejects.toThrow(/prompt failed/);
			// Cursor was explicitly reset to 0 (didReprime) so a passive review replays
			// BOTH history items, not just the tail after the pre-maintenance cursor.
			runtime.onTurnEnd(messages);
			await runtime.waitForCatchup(1000, 1);
			await flushMicrotasksUntil(() => promptCallCount >= 2);
			expect(promptInputs).toHaveLength(2);
			expect(promptInputs[1]).toContain("early primary history");
			expect(promptInputs[1]).toContain("recent primary turn");
		});
	});
});
