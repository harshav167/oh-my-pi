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
		// Both halves of the voice conversation replay: a resumed session has no
		// visualizer and no audio, so these rows are the only record of what was said.
		expect(rendered).toContain(VOICE_USER);
		expect(rendered).toContain(VOICE_ASSISTANT);
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

	it("draws what the call drew, not the full body the voice already delivered", () => {
		const { ctx, helpers } = makeHarness();
		const messages = ownedSession();
		// The common shape: the voice lane took the whole answer, so the call drew
		// nothing and a reload must not invent a block the call never showed.
		messages[messages.length - 2] = custom(LIVE_WORKER_MESSAGE_TYPE, SCREEN_BODY, {
			screen: SCREEN_BODY,
			withheld: "",
		});
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		expect(rendered).not.toContain("Branch report");
		// The turn is still visible — as what was actually said.
		expect(rendered).toContain(VOICE_ASSISTANT);
	});

	it("replays a pre-withheld row the old way, without doubling it with voice", () => {
		const { ctx, helpers } = makeHarness();
		const messages = ownedSession();
		// Rows written before `withheld` existed know only the full body. Replaying
		// the spoken turns on top of that artifact is the two-colour duplicate.
		messages[messages.length - 2] = custom(LIVE_WORKER_MESSAGE_TYPE, SCREEN_BODY, { screen: SCREEN_BODY });
		helpers.renderSessionContext({ messages } as SessionContext);
		const rendered = transcriptText(ctx);

		expect(rendered).toContain("Branch report");
		expect(rendered.split("Branch report").length - 1).toBe(1);
		expect(rendered).not.toContain(VOICE_ASSISTANT);
		expect(rendered).not.toContain(VOICE_USER);
		// The tool timeline is not prose and still replays.
		expect(rendered).toContain("git log");
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
