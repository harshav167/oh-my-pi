/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type ScopeLike } from "../config/registry";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS, LIVE_VOICE_VALUES } from "./voices";

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "enum",
	values: LIVE_VOICE_VALUES,
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Voice",
		description: "Voice used by Codex-backed realtime voice sessions",
		options: LIVE_VOICE_OPTIONS,
	},
});

/** The voice a live session uses: an explicit choice, else the `live.voice` setting, else the default. */
export function resolveLiveVoice(scope: ScopeLike, voice?: string): string {
	return voice?.trim() || cfgLiveVoice.get(scope) || DEFAULT_LIVE_VOICE;
}
/** How much the live voice says when the agent finishes a task; rendered into the voice instructions. */
export const cfgLiveAnswerLength = register({
	id: "live.answerLength",
	type: "enum",
	values: ["brief", "normal", "detailed"] as const,
	default: "normal",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Voice Answer Length",
		description: "How much the live voice says when the agent finishes a task",
		options: [
			{ value: "brief", label: "Brief", description: "The outcome and anything you must do, in a sentence or two" },
			{ value: "normal", label: "Normal", description: "The key takeaway, status or next step" },
			{
				value: "detailed",
				label: "Detailed",
				description: "The main findings and changes, in the voice's own words",
			},
		],
	},
});
