import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveVisualizer } from "@oh-my-pi/pi-coding-agent/live/visualizer";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentTurnOverrides } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveThinkingLevelForModel, toReasoningEffort } from "@oh-my-pi/pi-coding-agent/thinking";

/** Fake InteractiveModeContext plus typed capture channels for focus/mount traffic. */
interface ContextHarness {
	ctx: InteractiveModeContext;
	/** The editor stub the controller must restore after live mode ends. */
	editor: unknown;
	/** Every component handed to `ui.setFocus`, in order. */
	focused: unknown[];
	/** Every component handed to `editorContainer.addChild`, in order. */
	mounted: unknown[];
	/** Resolves when `ui.setFocus` sees the original editor again. */
	editorRefocused: Promise<void>;
}

function createContext(): ContextHarness {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	const focused: unknown[] = [];
	const mounted: unknown[] = [];
	const refocused = Promise.withResolvers<void>();
	const ctx = {
		settings: Settings.isolated({ "live.voice": "vale" }),
		keybindings: { getKeys: vi.fn(() => ["ctrl+l"]) },
		// `#buildLiveHost` reads these two eagerly when it narrows the session into
		// the host port; everything else it needs is behind a lazy closure that a
		// delegation would have to trigger.
		session: { modelRegistry: { authStorage: {} }, sessionId: "test-session" },
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: {
			clear: vi.fn(),
			addChild: vi.fn((component: unknown) => {
				mounted.push(component);
			}),
		},
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn((component: unknown) => {
				focused.push(component);
				if (component === editor) refocused.resolve();
			}),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: [] },
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, editor, focused, mounted, editorRefocused: refocused.promise };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected voice across the live-session boundary", async () => {
		const { ctx } = createContext();
		let receivedVoice: string | undefined;
		const controller = new LiveCommandController(ctx, options => {
			// The voice moved onto the resolved config, which is what the transport
			// now reads; the boundary this pins is unchanged.
			receivedVoice = options.config.voice;
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(receivedVoice).toBe("vale");
		} finally {
			await controller.stop();
		}
	});

	it("stops the session and restores the editor when the live-toggle chord hits the focused visualizer", async () => {
		const { ctx, editor, focused, mounted, editorRefocused } = createContext();
		const stop = vi.fn(async () => {});
		const controller = new LiveCommandController(ctx, options => {
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockImplementation(stop);
			return session;
		});

		await controller.handleCommand();
		expect(controller.active).toBe(true);

		// The controller replaces and focuses the editor with the visualizer;
		// Ctrl+L must end the call from there, not just from the editor.
		const visualizer = focused[0];
		if (!(visualizer instanceof LiveVisualizer)) {
			throw new Error("expected the controller to focus a LiveVisualizer");
		}
		visualizer.handleInput("\x0c"); // Ctrl+L — the keypress alone must drive teardown
		await editorRefocused;

		expect(stop).toHaveBeenCalled();
		expect(mounted.at(-1)).toBe(editor);
		expect(focused.at(-1)).toBe(editor);
		// `active` stays true until #finish's fire-and-forget settling promise
		// clears; drain microtasks deterministically instead of sleeping.
		for (let i = 0; controller.active && i < 20; i++) await Promise.resolve();
		expect(controller.active).toBe(false);
	});

	// A voice call must not silently retune the session. Both of these were hard
	// overrides — `openai-codex/gpt-5.6-terra` and effort `low` — so starting
	// /live swapped the user's model and discarded a deliberate effort choice,
	// and failed outright when the pinned provider had no credentials.
	it("inherits the session's model and effort when no live override is configured", async () => {
		const { ctx } = createContext();
		const sessionModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!sessionModel) throw new Error("bundled model claude-sonnet-4-5 not found");
		Object.assign(ctx.session, {
			model: sessionModel,
			thinkingLevel: ThinkingLevel.High,
			settings: ctx.settings,
		});
		let overrides: AgentTurnOverrides | undefined;
		const controller = new LiveCommandController(ctx, options => {
			overrides = options.host.resolveCodingOverrides();
			const session = new LiveSessionController(options);
			vi.spyOn(session, "start").mockResolvedValue();
			vi.spyOn(session, "stop").mockResolvedValue();
			return session;
		});

		try {
			await controller.handleCommand();
			expect(overrides?.model).toBe(sessionModel);
			expect(overrides?.thinkingLevel).toBe(
				toReasoningEffort(resolveThinkingLevelForModel(sessionModel, ThinkingLevel.High)),
			);
			// Proves it tracks the session rather than landing on `high` by luck.
			expect(overrides?.thinkingLevel).not.toBe(
				toReasoningEffort(resolveThinkingLevelForModel(sessionModel, ThinkingLevel.Low)),
			);
			// The voice contract still applies — that, not the model id, is what
			// constrains a delegated turn.
			expect(overrides?.systemPromptAppend?.[0]).toContain("realtime voice delegation");
		} finally {
			await controller.stop();
		}
	});
});
