import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/settings-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AudioDeviceInfo } from "@oh-my-pi/pi-natives";
import * as piNatives from "@oh-my-pi/pi-natives";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;
let audioDevicesSpy: { mockRestore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry();
	audioDevicesSpy = spyOn(piNatives, "listAudioDevices").mockReturnValue([
		{ id: "input-id", name: "Studio Microphone", kind: "input", isDefault: false },
		{ id: "output-id", name: "Desk Speakers", kind: "output", isDefault: false },
	]);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
	audioDevicesSpy?.mockRestore();
	audioDevicesSpy = undefined;
});

function stubStdoutGeometry(): { restore(): void } {
	const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 40, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => 180, set: () => {} });
	return {
		restore() {
			if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
			if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

describe("SettingsSelectorComponent live audio devices", () => {
	const cases: {
		readonly path: "live.inputDeviceId" | "live.outputDeviceId";
		readonly query: string;
		readonly device: AudioDeviceInfo;
	}[] = [
		{
			path: "live.inputDeviceId",
			query: "input device",
			device: { id: "input-id", name: "Studio Microphone", kind: "input", isDefault: false },
		},
		{
			path: "live.outputDeviceId",
			query: "output device",
			device: { id: "output-id", name: "Desk Speakers", kind: "output", isDefault: false },
		},
	];

	it.each(cases)(
		"renders the selected $device.kind device name instead of its encoded ID",
		({ path, query, device }) => {
			settings.set(path, device.id);
			const selector = createSelector();

			for (const character of query) selector.handleInput(character);
			const rendered = stripVTControlCharacters(selector.render(180).join("\n"));

			expect(rendered).toContain(device.name);
			expect(rendered).not.toContain(device.id);
		},
	);
});
