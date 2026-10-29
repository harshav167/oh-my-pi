import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { LiveClientMessage, LiveServerEvent } from "@oh-my-pi/pi-coding-agent/live/protocol";
import * as transportModule from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

function answer(text: string, timestamp: number): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp } as AssistantMessage;
}

function delegation(id: string, text: string): LiveServerEvent {
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
	};
}

/** Text the voice was asked to speak, in order: the joined speakable chunks of each final answer. */
function spoken(sent: LiveClientMessage[]): string {
	return sent
		.filter(message => message.type === "session.context.append" && message.channel === "speakable")
		.map(message => ("content" in message ? message.content.map(part => part.text).join("") : ""))
		.join("");
}

/** Drain the serialized delegation dispatch and its immediately resolved session/transport mocks. */
async function flushVoiceQueue(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function startedController(answerLength = "normal") {
	const sent: LiveClientMessage[] = [];
	let transportOptions: LiveTransportOptions | undefined;
	spyOn(transportModule, "CodexLiveTransport").mockImplementation(function (options: LiveTransportOptions) {
		transportOptions = options;
		return {
			setMuted: async () => {},
			connect: async () => {},
			setSpeakerSuppressed: () => {},
			close: async () => {},
			send: async (message: LiveClientMessage) => {
				sent.push(message);
			},
		};
	} as never);
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const customMessages: Array<{ content: unknown; details?: unknown }> = [];
	const customMessageOptions: Array<{ triggerTurn?: boolean } | undefined> = [];
	const aborts: Array<{ reason?: string } | undefined> = [];
	const lifecycle: string[] = [];
	let streaming = false;
	let nextSend: PromiseWithResolvers<boolean> | undefined;
	const session = {
		settings: Settings.isolated({ "live.answerLength": answerLength }),
		sessionId: "session-1",
		modelRegistry: { authStorage: {} },
		sessionManager: { appendCustomEntry: () => {} },
		dropPendingNextTurnMessages: () => 0,
		get isStreaming() {
			return streaming;
		},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
		sendCustomMessage: async (
			message: { content: unknown; details?: unknown },
			options?: { triggerTurn?: boolean },
		) => {
			customMessages.push(message);
			customMessageOptions.push(options);
			lifecycle.push("send");
			if (nextSend) {
				const pending = nextSend;
				nextSend = undefined;
				streaming = true;
				return pending.promise;
			}
			return !streaming;
		},
		abort: async (options?: { reason?: string }) => {
			aborts.push(options);
			lifecycle.push("abort");
			streaming = false;
		},
	} as unknown as AgentSession;
	const controller = new LiveSessionController({
		session,
		extractAssistantText: message => message.content.map(part => (part.type === "text" ? part.text : "")).join(""),
		callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
	});
	await controller.start();
	if (!transportOptions) throw new Error("The controller opened no transport");
	const options = transportOptions;
	return {
		controller,
		sent,
		session,
		customMessages,
		customMessageOptions,
		aborts,
		lifecycle,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		holdNextSend: () => {
			const pending = Promise.withResolvers<boolean>();
			nextSend = pending;
			return () => pending.resolve(true);
		},
		instructions: options.instructions,
		voice: (event: LiveServerEvent) => options.callbacks.onEvent(event),
		agent: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("voice request delivery", () => {
	test("a finished user transcript is delegated when the voice only acknowledges it", async () => {
		const { controller, voice, customMessages } = await startedController();
		voice({ type: "input_transcript.added", item: { text: " Okay, wait, never mind" } });
		voice({ type: "turn.done", turn: { role: "user", transcript: " Okay, wait, never mind" } });
		await flushVoiceQueue();

		expect(customMessages.map(message => message.content)).toEqual(["Okay, wait, never mind"]);
		await controller.stop();
	});

	test("a server delegation consumes its user turn without a transcript fallback", async () => {
		const { controller, voice, customMessages } = await startedController();
		voice({ type: "input_transcript.added", item: { text: "check the build" } });
		voice(delegation("d1", "check the build"));
		voice({ type: "turn.done", turn: { role: "user", transcript: "check the build" } });
		await flushVoiceQueue();

		expect(customMessages.map(message => message.content)).toEqual(["check the build"]);
		await controller.stop();
	});

	test("a late server delegation does not duplicate a transcript fallback", async () => {
		const { controller, voice, customMessages } = await startedController();
		voice({ type: "input_transcript.added", item: { text: "never mind" } });
		voice({ type: "turn.done", turn: { role: "user", transcript: "never mind" } });
		voice(delegation("late", "never mind"));
		await flushVoiceQueue();

		expect(customMessages.map(message => message.content)).toEqual(["never mind"]);
		await controller.stop();
	});

	test("a voice request aborts active work before starting its own turn", async () => {
		const { controller, voice, setStreaming, customMessageOptions, aborts, lifecycle } = await startedController();
		setStreaming(true);
		voice(delegation("d1", "stop and answer this instead"));
		await flushVoiceQueue();

		expect(lifecycle).toEqual(["abort", "send"]);
		expect(aborts).toEqual([{ reason: USER_INTERRUPT_LABEL }]);
		expect(customMessageOptions).toEqual([{ triggerTurn: true }]);
		await controller.stop();
	});

	test("a newer voice request interrupts before the previous send settles", async () => {
		const { controller, voice, holdNextSend, lifecycle, aborts } = await startedController();
		const releaseFirstTurn = holdNextSend();
		voice(delegation("d1", "first request"));
		await flushVoiceQueue();
		voice(delegation("d2", "newer request"));
		await flushVoiceQueue();

		expect(lifecycle).toEqual(["send", "abort", "send"]);
		expect(aborts).toEqual([{ reason: USER_INTERRUPT_LABEL }]);
		releaseFirstTurn();
		await controller.stop();
	});

	test("the aborted run's completion cannot clear the replacement run", async () => {
		const { controller, sent, session, voice, agent, setStreaming } = await startedController();
		voice(delegation("d1", "first request"));
		await flushVoiceQueue();
		const first = answer("First answer.", 1);
		const second = answer("Second answer.", 2);
		const abort = session.abort.bind(session);
		spyOn(session, "abort").mockImplementation(async options => {
			agent({ type: "agent_end", messages: [first], isTerminal: true, yielded: true });
			await abort(options);
		});

		setStreaming(true);
		voice(delegation("d2", "replacement request"));
		await flushVoiceQueue();
		agent({ type: "agent_end", messages: [first, second], isTerminal: true, yielded: true });

		expect(spoken(sent)).toBe("First answer.Second answer.");
		await controller.stop();
	});
});

describe("final answers handed to the voice", () => {
	test("a completed answer is spoken even when the agent continues with more work", async () => {
		const { controller, sent, voice, agent } = await startedController();
		voice(delegation("d1", "check the instrumentation"));
		await flushVoiceQueue();
		const intermediate = answer("There are no audio health metrics.", 1);

		agent({ type: "message_end", message: intermediate });
		agent({ type: "agent_end", messages: [intermediate], isTerminal: false, yielded: false });

		expect(spoken(sent)).toBe("There are no audio health metrics.");
		await controller.stop();
	});

	test("an answer without a voice-output acknowledgement is retried once on the next request", async () => {
		const { controller, sent, voice, agent } = await startedController();
		voice(delegation("d1", "is it ready"));
		await flushVoiceQueue();
		const completed = answer("The merge is ready.", 1);
		agent({ type: "agent_end", messages: [completed], isTerminal: true, yielded: true });
		expect(spoken(sent)).toBe("The merge is ready.");

		voice({ type: "input_transcript.added", item: { text: "wait, one more thing" } });
		voice(delegation("d2", "wait, one more thing"));
		voice({ type: "turn.done", turn: { role: "user", transcript: "wait, one more thing" } });
		await flushVoiceQueue();
		expect(spoken(sent)).toBe("The merge is ready.The merge is ready.");

		voice({ type: "output_transcript.added", item: { text: "The merge is ready." } });
		voice({ type: "turn.done", turn: { role: "assistant", transcript: "The merge is ready." } });
		voice(delegation("d3", "another request"));
		await flushVoiceQueue();
		expect(spoken(sent)).toBe("The merge is ready.The merge is ready.");
		await controller.stop();
	});

	test("an answer written while a background job still runs is spoken in full, and the answer after its results too", async () => {
		const { controller, sent, voice, agent } = await startedController();
		voice(delegation("d1", "look into the connect bug"));
		await flushVoiceQueue();

		// Longer than the old 1,000-token cut: the voice gets all of it.
		const first = answer(`Found it. ${"The installation row is per workspace. ".repeat(150)}End.`, 1);
		agent({ type: "agent_end", messages: [first], isTerminal: false, yielded: true, awaitingAsyncWork: true });
		expect(spoken(sent)).toBe(first.content[0]?.type === "text" ? first.content[0].text : "");

		const second = answer("The scout confirmed the cause.", 2);
		agent({ type: "agent_end", messages: [first, second], isTerminal: true, yielded: true });
		expect(spoken(sent)).toEndWith("End.The scout confirmed the cause.");

		await controller.stop();
	});

	test("a background resume that writes no new answer does not repeat the spoken one", async () => {
		const { controller, sent, voice, agent } = await startedController();
		voice(delegation("d1", "check the build"));
		await flushVoiceQueue();
		const only = answer("Build is green.", 1);

		agent({ type: "agent_end", messages: [only], isTerminal: false, yielded: true, awaitingAsyncWork: true });
		agent({ type: "agent_end", messages: [only], isTerminal: true, yielded: true });
		expect(spoken(sent)).toBe("Build is green.");

		await controller.stop();
	});

	test("an end the agent continues past on its own speaks nothing", async () => {
		const { controller, sent, voice, agent } = await startedController();
		voice(delegation("d1", "check the build"));
		await flushVoiceQueue();

		agent({ type: "agent_end", messages: [answer("Retrying.", 1)], isTerminal: false, yielded: false });
		expect(spoken(sent)).toBe("");

		await controller.stop();
	});
});

describe("live.answerLength", () => {
	test("brief and detailed add their own spoken-length guidance to the voice instructions; normal adds none", async () => {
		const rendered: Record<string, string> = {};
		for (const length of ["brief", "normal", "detailed"]) {
			const { controller, instructions } = await startedController(length);
			rendered[length] = instructions;
			await controller.stop();
			vi.restoreAllMocks();
		}
		expect(rendered.normal).not.toContain("## Spoken answer length");
		expect(rendered.brief).toContain("## Spoken answer length");
		expect(rendered.detailed).toContain("## Spoken answer length");
		expect(rendered.brief).not.toBe(rendered.detailed);
		expect(rendered.brief.startsWith(rendered.normal.trimEnd())).toBe(true);
	});
});

function startupSession(): AgentSession {
	return {
		settings: Settings.isolated(),
		sessionId: "startup-session",
		modelRegistry: { authStorage: {} },
		sessionManager: { appendCustomEntry: () => {} },
		dropPendingNextTurnMessages: () => 0,
		subscribe: () => () => {},
		sendCustomMessage: async () => {},
	} as unknown as AgentSession;
}

describe("startup transport ownership", () => {
	test("a phase callback failure stops startup before constructing a transport", async () => {
		let constructed = 0;
		spyOn(transportModule, "CodexLiveTransport").mockImplementation(function (_options: LiveTransportOptions) {
			constructed += 1;
			return { setMuted: async () => {}, connect: async () => {}, close: async () => {} };
		} as never);
		const controller = new LiveSessionController({
			session: startupSession(),
			extractAssistantText: () => "",
			callbacks: {
				onPhase: () => {
					throw new Error("phase failed");
				},
				onLevels: () => {},
				onTranscript: () => {},
				onTerminal: () => {},
			},
		});

		await expect(controller.start()).rejects.toThrow("phase failed");
		expect(constructed).toBe(0);
	});

	test("stopping during connect still closes the constructed transport", async () => {
		const close = vi.fn(async () => {});
		const controller = new LiveSessionController({
			session: startupSession(),
			extractAssistantText: () => "",
			callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
		});
		spyOn(transportModule, "CodexLiveTransport").mockImplementation(function (_options: LiveTransportOptions) {
			return {
				setMuted: async () => {},
				connect: async () => {
					await controller.stop();
				},
				setSpeakerSuppressed: () => {},
				close,
				send: async () => {},
			};
		} as never);

		await expect(controller.start()).rejects.toThrow("stopped");
		expect(close).toHaveBeenCalledTimes(1);
	});
});
