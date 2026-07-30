import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { LiveCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/live-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createContext(): InteractiveModeContext {
	const editor = {
		getUseTerminalCursor: vi.fn(() => true),
		setUseTerminalCursor: vi.fn(),
	};
	return {
		settings: Settings.isolated({ "live.voice": "vale" }),
		// `#buildLiveHost` reads these two eagerly when it narrows the session into
		// the host port; everything else it needs is behind a lazy closure that a
		// delegation would have to trigger.
		session: { modelRegistry: { authStorage: {} }, sessionId: "test-session" },
		extractAssistantText: vi.fn(() => ""),
		editor,
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		ui: {
			getShowHardwareCursor: vi.fn(() => true),
			setShowHardwareCursor: vi.fn(),
			setFocus: vi.fn(),
			requestRender: vi.fn(),
			requestComponentRender: vi.fn(),
		},
		showError: vi.fn(),
		chatContainer: { children: [] },
		present: vi.fn(),
	} as unknown as InteractiveModeContext;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("LiveCommandController", () => {
	it("forwards the selected voice across the live-session boundary", async () => {
		const ctx = createContext();
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
});
