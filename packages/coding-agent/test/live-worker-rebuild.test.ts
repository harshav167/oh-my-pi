/**
 * A `/live` delegation owns its turn's PROSE. During the call the event
 * controller suppresses that turn's assistant text and the handoff draws only
 * what the voice did not carry; on reload the transcript must reach the same
 * shape from the persisted boundary rows instead of replaying the delegated turn
 * as ordinary main-agent output.
 *
 * Contracts under test:
 *  - the delegated assistant prose is not rendered
 *  - its tool timeline IS rendered, call and result, so a resumed session shows
 *    the work the call showed live rather than a bare report
 *  - the screen body renders once, credited to the coding model that produced it
 *    (not the voice model)
 *  - a user message that landed inside the range still renders
 *  - records outside any range are untouched
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import {
	LIVE_DELEGATION_MESSAGE_TYPE,
	LIVE_TAIL_MESSAGE_TYPE,
	LIVE_TRANSCRIPT_MESSAGE_TYPE,
	LIVE_WORKER_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container } from "@oh-my-pi/pi-tui";

const SCREEN_BODY = "## Branch report\n\nThree commits landed.";
const SPOKEN_TEXT = "Three commits landed; details are on screen.";
const OUTSIDE_TEXT = "An ordinary terminal answer.";
const VOICE_USER = "Check the branch for me.";
const VOICE_ASSISTANT = "Three commits landed; the details are up on screen.";

function assistant(text: string, model: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model,
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	} as unknown as AgentMessage;
}

function custom(customType: string, content: string, details?: unknown): AgentMessage {
	return { role: "custom", customType, content, display: false, details, timestamp: 1 } as unknown as AgentMessage;
}

function ownedSession(): AgentMessage[] {
	return [
		custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>inspect</input></realtime_delegation>"),
		custom(LIVE_TRANSCRIPT_MESSAGE_TYPE, VOICE_USER, { role: "user", text: VOICE_USER }),
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "git log" } }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.6-terra",
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 1,
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text: "e4070c4ce feat: video" }],
			timestamp: 1,
		} as unknown as AgentMessage,
		{ role: "user", content: "wait, also check main", timestamp: 1 } as unknown as AgentMessage,
		assistant(`${SPOKEN_TEXT}${SCREEN_BODY}`, "gpt-5.6-terra"),
		custom(LIVE_TRANSCRIPT_MESSAGE_TYPE, VOICE_ASSISTANT, {
			role: "assistant",
			text: VOICE_ASSISTANT,
			model: "gpt-live-1-codex",
		}),
		custom(LIVE_WORKER_MESSAGE_TYPE, SCREEN_BODY, { screen: SCREEN_BODY, withheld: SCREEN_BODY }),
		assistant(OUTSIDE_TEXT, "gpt-5.6-sol"),
	];
}

function makeHarness(): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	let helpers: UiHelpers;
	const ctx = {
		chatContainer: new Container(),
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: () => false },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		getUserMessageText: (message: AgentMessage) => helpers.getUserMessageText(message as never),
		session: {
			retryAttempt: 0,
			getToolByName: () => undefined,
			sessionManager: { getCwd: () => process.cwd(), putBlobSync: () => undefined },
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, helpers };
}

/** Rendered transcript, unstyled: colour codes split words like `git log` apart. */
function transcriptText(ctx: InteractiveModeContext): string {
	return Bun.stripANSI(ctx.chatContainer.children.map(child => child.render(120).join("\n")).join("\n"));
}

describe("UiHelpers.renderSessionContext projects a live-owned delegation", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("suppresses the delegated turn and renders its screen body once", () => {
		const { ctx, helpers } = makeHarness();
		helpers.renderSessionContext({ messages: ownedSession() } as SessionContext);
		const rendered = transcriptText(ctx);

		// The spoken half went to voice during the call; replaying it here is the
		// duplicate main-agent output this projection exists to remove.
		expect(rendered).not.toContain(SPOKEN_TEXT);
		// The tool timeline is not prose: it is the delegated work, and Codex keeps
		// it in scrollback. Suppressing it left a resumed call showing a report with
		// no evidence of how it was produced.
		expect(rendered).toContain("git log");
		expect(rendered).toContain("e4070c4ce");
		// The report itself survives the reload, exactly once.
		expect(rendered).toContain("Branch report");
		expect(rendered.split("Branch report").length - 1).toBe(1);
		// The user's own speech replays: a resumed session has no visualizer and no
		// audio, and nothing else carries it. The agent's spoken paraphrase does not,
		// because the artifact below is the same answer said precisely.
		expect(rendered).toContain(VOICE_USER);
		expect(rendered).not.toContain(VOICE_ASSISTANT);
	});

	it("keeps records that are not part of the delegated turn", () => {
		const { ctx, helpers } = makeHarness();
		helpers.renderSessionContext({ messages: ownedSession() } as SessionContext);
		const rendered = transcriptText(ctx);

		// A user turn that landed mid-delegation is not the worker's presentation.
		expect(rendered).toContain("wait, also check main");
		// And the range closed, so later ordinary output still renders.
		expect(rendered).toContain(OUTSIDE_TEXT);
	});

	it("replays the whole body even when the call itself drew nothing", () => {
		const { ctx, helpers } = makeHarness();
		const messages = ownedSession();
		// The common shape: the voice lane took the whole answer, so the call drew
		// nothing. `withheld` is a live-only signal — a reload has no voice, so the
		// body is the turn's answer and must still appear.
		messages[messages.length - 2] = custom(LIVE_WORKER_MESSAGE_TYPE, SCREEN_BODY, {
			screen: SCREEN_BODY,
			withheld: "",
		});
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		expect(rendered).toContain("Branch report");
		expect(rendered.split("Branch report").length - 1).toBe(1);
		// One carrier per range: the paraphrase would be the same reply twice.
		expect(rendered).not.toContain(VOICE_ASSISTANT);
		expect(rendered).toContain(VOICE_USER);
	});

	it("replays a row written before the drawn projection existed", () => {
		const { ctx, helpers } = makeHarness();
		const messages = ownedSession();
		// Rows predating `withheld` know only the full body, and take the same path.
		messages[messages.length - 2] = custom(LIVE_WORKER_MESSAGE_TYPE, SCREEN_BODY, { screen: SCREEN_BODY });
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		expect(rendered).toContain("Branch report");
		expect(rendered.split("Branch report").length - 1).toBe(1);
		expect(rendered).not.toContain(VOICE_ASSISTANT);
		// The tool timeline is not prose and still replays.
		expect(rendered).toContain("git log");
	});

	it("pairs interleaved boundaries left by a steered correction", () => {
		const { ctx, helpers } = makeHarness();
		// A correction sends through the same `live-delegation` type, and the session
		// persists its opener while the turn it replaces is still streaming: the rows
		// read open(A) open(B) close(A) close(B). Pairing by position either loses A
		// or orphans B, dropping an artifact and leaving a range unsuppressed.
		const messages = [
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>first</input></realtime_delegation>", {
				delegationId: "a",
			}),
			assistant(`${SPOKEN_TEXT}First report.`, "gpt-5.6-terra"),
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>correction</input></realtime_delegation>", {
				delegationId: "b",
			}),
			custom(LIVE_WORKER_MESSAGE_TYPE, "First report.", {
				screen: "First report.",
				withheld: "",
				delegationId: "a",
			}),
			assistant(`${SPOKEN_TEXT}Second report.`, "gpt-5.6-sol"),
			custom(LIVE_WORKER_MESSAGE_TYPE, "Second report.", {
				screen: "Second report.",
				withheld: "",
				delegationId: "b",
			}),
		] as AgentMessage[];
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		// Both artifacts survive, each exactly once, and each range hid its own prose.
		expect(rendered).toContain("First report.");
		expect(rendered).toContain("Second report.");
		expect(rendered.split("First report.").length - 1).toBe(1);
		expect(rendered.split("Second report.").length - 1).toBe(1);
		expect(rendered).not.toContain(SPOKEN_TEXT);
	});

	it("refuses to pair a later close with a crashed call's opener", () => {
		const { ctx, helpers } = makeHarness();
		// The crash case: `a` never closed. Its opener must not swallow `b`'s close,
		// which would suppress history belonging to a range that did finish.
		const messages = [
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>crashed</input></realtime_delegation>", {
				delegationId: "a",
			}),
			assistant(`${SPOKEN_TEXT}Lost work.`, "gpt-5.6-terra"),
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>later</input></realtime_delegation>", {
				delegationId: "b",
			}),
			assistant("Later report.", "gpt-5.6-sol"),
			custom(LIVE_WORKER_MESSAGE_TYPE, "Later report.", {
				screen: "Later report.",
				withheld: "",
				delegationId: "b",
			}),
		] as AgentMessage[];
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		// `b` projects normally; `a` degrades to replaying its raw turn.
		expect(rendered).toContain("Later report.");
		expect(rendered).toContain(SPOKEN_TEXT);
	});

	it("refuses every id-less pairing once legacy rows become ambiguous", () => {
		const { ctx, helpers } = makeHarness();
		// `open open close open close close`, all from before ids existed. Resuming
		// legacy pairing after the first close matched the second one to the wrong
		// opener and suppressed a turn that range never owned, so ambiguity latches
		// for the rest of the transcript and these ranges replay raw instead.
		const messages = [
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>a</input></realtime_delegation>"),
			assistant(`${SPOKEN_TEXT}A.`, "gpt-5.6-terra"),
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>b</input></realtime_delegation>"),
			custom(LIVE_WORKER_MESSAGE_TYPE, "A.", { screen: "A." }),
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>c</input></realtime_delegation>"),
			assistant(`${OUTSIDE_TEXT}`, "gpt-5.6-sol"),
			custom(LIVE_WORKER_MESSAGE_TYPE, "B.", { screen: "B." }),
			custom(LIVE_WORKER_MESSAGE_TYPE, "C.", { screen: "C." }),
		] as AgentMessage[];
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		// Nothing is suppressed on a guess: both turns' own prose still replays.
		expect(rendered).toContain(SPOKEN_TEXT);
		expect(rendered).toContain(OUTSIDE_TEXT);
	});

	it("keeps a transcript-tail row from opening an ownership range", () => {
		const { ctx, helpers } = makeHarness();
		// The row `/live` writes at teardown. Filed as a delegation it opened a range
		// that a later close could pair with, suppressing prose that was never
		// delegated at all.
		const messages = [
			custom(
				LIVE_TAIL_MESSAGE_TYPE,
				"<realtime_delegation><source>transcript_tail_flush</source></realtime_delegation>",
			),
			assistant(OUTSIDE_TEXT, "gpt-5.6-sol"),
			custom(LIVE_WORKER_MESSAGE_TYPE, SCREEN_BODY, { screen: SCREEN_BODY, withheld: SCREEN_BODY }),
		];
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		expect(rendered).toContain(OUTSIDE_TEXT);
	});
});

describe("UiHelpers.renderSessionContext handles an unclosed live range", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("renders later history normally when the boundary row was never written", () => {
		// Best-effort persistence: a crash or a failed log write can leave the
		// opening row with no close. Suppressing to end-of-file would hide the rest
		// of the session, which is strictly worse than replaying one raw turn.
		const { ctx, helpers } = makeHarness();
		const messages: AgentMessage[] = [
			custom(LIVE_DELEGATION_MESSAGE_TYPE, "<realtime_delegation><input>inspect</input></realtime_delegation>"),
			assistant(`${SPOKEN_TEXT}${SCREEN_BODY}`, "gpt-5.6-terra"),
			assistant(OUTSIDE_TEXT, "gpt-5.6-sol"),
		];
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		expect(rendered).toContain(OUTSIDE_TEXT);
		expect(rendered).toContain(SPOKEN_TEXT);
	});
});

describe("UiHelpers.renderSessionContext ignores an orphan live-worker row", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("does not credit a close with no opener to the preceding assistant", () => {
		// A close row with no matching delegation has no range behind it. Projecting
		// it would attribute a report to whatever ordinary turn happened to precede
		// it and suppress nothing, so it is skipped entirely.
		const { ctx, helpers } = makeHarness();
		const messages: AgentMessage[] = [
			assistant(OUTSIDE_TEXT, "gpt-5.6-sol"),
			custom(LIVE_WORKER_MESSAGE_TYPE, SCREEN_BODY, { screen: SCREEN_BODY }),
		];
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		expect(rendered).toContain(OUTSIDE_TEXT);
		expect(rendered).not.toContain("Branch report");
	});
});
