import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { LiveHandoffBridge, type LiveHandoffSession } from "../src/live/handoff";
import type { LiveClientMessage, LiveServerEvent } from "../src/live/protocol";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

/**
 * The bridge against an `AgentSession`-shaped peer whose `triggerTurn` send
 * resolves only when the turn ends — the real contract of
 * `AgentSession.sendCustomMessage`, which awaits `agent.prompt`.
 *
 * The bridge serializes every mutation on one FIFO chain, so awaiting a
 * triggered turn inside that chain would stall the very lifecycle events the
 * turn emits. These tests exercise that ordering end to end.
 */

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function delegation(id: string, text: string): Extract<LiveServerEvent, { type: "delegation.created" }> {
	return {
		type: "delegation.created",
		item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
	};
}

/**
 * A session that streams a whole assistant turn and only then resolves the
 * `triggerTurn` promise, mirroring `AgentSession.sendCustomMessage`.
 */
class TurnRunningSession implements LiveHandoffSession {
	readonly requests: string[] = [];
	isStreaming = false;
	aborts = 0;
	#listener: ((event: AgentSessionEvent) => void) | undefined;
	#abortCurrent: (() => void) | undefined;

	subscribe(listener: (event: AgentSessionEvent) => void): void {
		this.#listener = listener;
	}

	async sendCustomMessage(
		message: unknown,
		options?: { triggerTurn?: boolean; deliverAs?: string; onAccepted?: () => void },
	): Promise<boolean> {
		const content = typeof message === "object" && message && "content" in message ? String(message.content) : "";
		this.requests.push(content);
		if (options?.triggerTurn !== true) {
			options?.onAccepted?.();
			return false;
		}
		// Ownership is reported before the turn runs, mirroring the real session.
		options.onAccepted?.();
		await this.#runTurn(content);
		return true;
	}

	async abort(): Promise<void> {
		this.aborts += 1;
		this.#abortCurrent?.();
	}

	async #runTurn(request: string): Promise<void> {
		this.isStreaming = true;
		const aborted = Promise.withResolvers<void>();
		this.#abortCurrent = () => aborted.resolve();
		const reply = `handled ${request.match(/<input>(.*?)<\/input>/)?.[1] ?? request}`;

		this.#emit({ type: "message_start", message: assistant("") });
		await Promise.resolve();
		const partial = assistant(reply);
		this.#emit({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply, partial },
		});
		await Promise.resolve();
		this.#emit({ type: "message_end", message: assistant(reply) });
		await Promise.resolve();
		this.isStreaming = false;
		this.#emit({ type: "agent_end", messages: [assistant(reply)], isTerminal: true });
		this.#abortCurrent = undefined;
		void aborted;
	}

	#emit(event: AgentSessionEvent): void {
		this.#listener?.(event);
	}
}

function createBridge(session: TurnRunningSession, sent: LiveClientMessage[]) {
	const bridge = new LiveHandoffBridge({
		session,
		send: async message => {
			sent.push(message);
		},
		extractAssistantText: message =>
			message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join(""),
		config: {
			handoffFlushMs: 5,
			flushTranscriptTail: true,
		},
	});
	session.subscribe(event => bridge.handleSessionEvent(event));
	return bridge;
}

function spoken(sent: LiveClientMessage[]): string {
	return sent
		.flatMap(message => ("content" in message ? message.content : []))
		.map(content => content.text)
		.join("");
}

describe("LiveHandoffBridge against a turn-running session", () => {
	it("does not stall the event chain while a triggered turn is running", async () => {
		const session = new TurnRunningSession();
		const sent: LiveClientMessage[] = [];
		const bridge = createBridge(session, sent);

		await bridge.handleDelegation(delegation("d1", "inspect the repo"));
		await bridge.flush();

		expect(session.requests).toHaveLength(1);
		// Markers come from the model under the voice contract; the bridge no
		// longer staples them onto whatever the backend produced.
		expect(spoken(sent)).toBe("handled inspect the repo");
	});

	it("completes one delegation before starting the next", async () => {
		const session = new TurnRunningSession();
		const sent: LiveClientMessage[] = [];
		const bridge = createBridge(session, sent);

		await bridge.handleDelegation(delegation("d1", "first"));
		await bridge.flush();
		await bridge.handleDelegation(delegation("d2", "second"));
		await bridge.flush();

		const ids = sent.flatMap(message =>
			message.type === "delegation.context.append" ? [message.delegation_item_id] : [],
		);
		expect(new Set(ids)).toEqual(new Set(["d1", "d2"]));
		expect(spoken(sent)).toBe("handled firsthandled second");
	});

	it("cancels a running turn and runs exactly one replacement", async () => {
		const session = new TurnRunningSession();
		const sent: LiveClientMessage[] = [];
		const bridge = createBridge(session, sent);

		// Both arrive before the first turn's lifecycle events drain, which is
		// what "cancel the running task" means in a real call.
		const first = bridge.handleDelegation(delegation("d1", "long job"));
		const second = bridge.handleDelegation(delegation("d2", "[[LIVE_CANCEL_ACTIVE]] do this instead"));
		await first;
		await second;
		await bridge.flush();

		expect(session.aborts).toBe(1);
		const triggered = session.requests.filter(request => request.includes("<realtime_delegation>"));
		expect(triggered).toHaveLength(2);
		expect(triggered.at(-1)).toContain("do this instead");
	});

	it("delivers the unhandled transcript tail to the session exactly once", async () => {
		const session = new TurnRunningSession();
		const sent: LiveClientMessage[] = [];
		const bridge = createBridge(session, sent);

		bridge.handleRealtimeEvent({ type: "turn.done", turn: { role: "user", transcript: "thanks, bye" } });
		await bridge.dispose();

		const tails = session.requests.filter(request => request.includes("transcript_tail_flush"));
		expect(tails).toHaveLength(1);
		expect(tails[0]).toContain("user: thanks, bye");
	});

	it("does not repeat turns already carried by a delegation in the tail", async () => {
		const session = new TurnRunningSession();
		const sent: LiveClientMessage[] = [];
		const bridge = createBridge(session, sent);

		bridge.handleRealtimeEvent({ type: "turn.done", turn: { role: "user", transcript: "check the tests" } });
		await bridge.handleDelegation(delegation("d1", "check the tests"));
		await bridge.flush();
		await bridge.dispose();

		const tails = session.requests.filter(request => request.includes("transcript_tail_flush"));
		expect(tails).toHaveLength(0);
	});
});

describe("LiveHandoffBridge control tokens", () => {
	it("never forwards the cancel sentinel to the coding agent", async () => {
		const session = new TurnRunningSession();
		const sent: LiveClientMessage[] = [];
		const bridge = createBridge(session, sent);

		// No turn is running, so this is a plain request that merely happens to
		// carry the sentinel.
		await bridge.handleDelegation(delegation("d1", "[[LIVE_CANCEL_ACTIVE]] just do it"));
		await bridge.flush();

		expect(session.requests).toHaveLength(1);
		expect(session.requests[0]).not.toContain("LIVE_CANCEL_ACTIVE");
		expect(session.requests[0]).toContain("just do it");
	});
});
