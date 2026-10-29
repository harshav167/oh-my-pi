import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { LiveSessionController } from "@oh-my-pi/pi-coding-agent/live/controller";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import { LiveVisualizer } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

class TestModalEditor extends CustomEditor {}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editorContainer.children).toEqual([mode.editor]);
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("keeps live mounted across editor replacement and stops it while Ask owns focus", async () => {
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		vi.spyOn(LiveSessionController.prototype, "start").mockResolvedValue();
		vi.spyOn(LiveSessionController.prototype, "stop").mockResolvedValue();
		const previousEditor = mode.editor;
		const hardwareCursor = mode.ui.getShowHardwareCursor();
		const terminalCursor = previousEditor.getUseTerminalCursor();
		previousEditor.setText("voice draft");
		const dialogAbort = new AbortController();
		try {
			await mode.handleLiveCommand();
			const visualizer = mode.editorContainer.children[0];
			expect(visualizer).toBeInstanceOf(LiveVisualizer);
			expect(mode.isLiveActive()).toBe(true);

			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			const replacement = mode.editor;
			expect(replacement).not.toBe(previousEditor);
			expect(replacement.getText()).toBe("voice draft");
			expect(mode.editorContainer.children).toEqual([visualizer]);
			expect(mode.ui.getFocused()).toBe(visualizer);

			replacement.setText("");
			const ask = new ExtensionUiController(mode).showAskDialog(
				[{ id: "continue", question: "Continue?", options: [{ label: "Yes" }] }],
				{ signal: dialogAbort.signal },
			);
			const dialog = mode.ui.getFocused();
			expect(dialog).toBeInstanceOf(AskDialogComponent);
			if (!(dialog instanceof AskDialogComponent)) throw new Error("Expected Ask to own focus");
			expect(mode.editorContainer.children).toEqual([dialog, visualizer]);
			const toggle = vi.spyOn(mode, "handleLiveCommand");
			mode.ui.injectDebugInput("\x0c");
			expect(toggle).toHaveBeenCalledTimes(1);
			await toggle.mock.results[0]!.value;

			expect(mode.isLiveActive()).toBe(false);
			expect(mode.editorContainer.children).toEqual([dialog, replacement]);
			expect(mode.ui.getFocused()).toBe(dialog);
			expect(mode.ui.getShowHardwareCursor()).toBe(hardwareCursor);
			expect(replacement.getUseTerminalCursor()).toBe(terminalCursor);
			mode.ui.injectDebugInput("\x1b");
			expect(await ask).toBeUndefined();
			expect(mode.editorContainer.children).toEqual([replacement]);
			expect(mode.ui.getFocused()).toBe(replacement);
		} finally {
			dialogAbort.abort();
			if (mode.isLiveActive()) await mode.handleLiveCommand();
		}
	});

	it("exposes the active editor factory while replacing the editor", () => {
		const firstFactory = (_tui: unknown, editorTheme: ConstructorParameters<typeof TestModalEditor>[0]) =>
			new TestModalEditor(editorTheme);
		mode.setEditorComponent(firstFactory);

		expect(mode.getEditorComponent()).toBe(firstFactory);

		let previousFactory: unknown;
		const secondFactory = (_tui: unknown, editorTheme: ConstructorParameters<typeof TestModalEditor>[0]) => {
			previousFactory = mode.getEditorComponent();
			return new TestModalEditor(editorTheme);
		};
		mode.setEditorComponent(secondFactory);

		expect(previousFactory).toBe(firstFactory);
		expect(mode.getEditorComponent()).toBe(secondFactory);

		mode.setEditorComponent(undefined);
		expect(mode.getEditorComponent()).toBeUndefined();
	});

	it("keeps the startup submit gate on an editor swapped in before init lifts it", () => {
		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		expect(mode.editor.disableSubmit).toBe(true);

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
		expect(mode.editor.disableSubmit).toBe(true);

		mode.editor.disableSubmit = false;
		mode.setEditorComponent(undefined);
		expect(mode.editor.disableSubmit).toBe(false);
	});
});
