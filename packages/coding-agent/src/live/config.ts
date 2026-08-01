import type { Effort } from "@oh-my-pi/pi-ai";
import { LiveAgcMode, LiveEchoCancellationMode, LiveNoiseSuppressionLevel } from "@oh-my-pi/pi-natives";
import type { Settings } from "../config/settings";

export const LIVE_VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"] as const;
export type LiveVoice = (typeof LIVE_VOICES)[number];

// Re-exported rather than redeclared as string unions: the native APM owns these
// closed sets, and a parallel union is exactly what let a value the settings
// layer could express silently disable a processing stage in Rust.
export { LiveAgcMode, LiveEchoCancellationMode, LiveNoiseSuppressionLevel };

/**
 * Sentinel for "use whatever effort the session is already on". Lives here
 * rather than beside `AUTO_THINKING` because it is a live-only selector:
 * `auto` asks the agent to pick an effort per prompt, `inherit` never overrides
 * the user's own current choice.
 */
export const INHERIT_THINKING = "inherit" as const;

/** Display metadata for {@link INHERIT_THINKING} in the settings UI. */
export const INHERIT_THINKING_METADATA = {
	value: INHERIT_THINKING,
	label: "inherit",
	description: "Use the session's current effort",
} as const;

export interface LiveConfig {
	readonly model: string;
	/** Model for delegated coding turns; empty inherits the session's model. */
	readonly codingModel: string;
	/** Effort for delegated coding turns; `undefined` inherits the session's. */
	readonly codingThinkingLevel: Effort | undefined;
	readonly voice: LiveVoice;
	readonly connectTimeoutMs: number;
	readonly sidebandConnectAttempts: number;
	readonly inactivityTimeoutMinutes: number;
	/** Rendered-output RMS above which the assistant counts as speaking. */
	readonly outputActiveLevel: number;
	/** Microphone RMS that counts as speech for inactivity tracking only. */
	readonly vadStartRms: number;
	readonly echoCancellationMode: LiveEchoCancellationMode;
	readonly echoDelayMs: number;
	readonly noiseSuppressionLevel: LiveNoiseSuppressionLevel;
	readonly agcMode: LiveAgcMode;
	readonly agcTargetLevelDbfs: number;
	readonly agcCompressionGainDb: number;
	readonly agcLimiter: boolean;
	readonly inputDeviceId: string;
	readonly outputDeviceId: string;
	readonly includeContinuity: boolean;
	readonly continuityMaxItems: number;
	readonly continuityMaxTokens: number;
	readonly handoffFlushMs: number;
	readonly flushTranscriptTail: boolean;
	readonly computerUse: "auto" | "off";
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Parses the settings string into the closed native mode.
 *
 * The settings layer stores these as plain strings, so this is the one boundary
 * where they become the enum the Rust APM matches exhaustively. An unrecognized
 * value fails here rather than silently disabling a processing stage.
 */
function parseMode<T extends string>(value: string, allowed: Readonly<Record<string, T>>, setting: string): T {
	const mode = Object.values(allowed).find(candidate => candidate === value);
	if (!mode) throw new Error(`${setting} has unsupported value "${value}"`);
	return mode;
}

/** Maps the `inherit` sentinel to `undefined`; concrete efforts pass through. */
function concreteLiveEffort(level: string): Effort | undefined {
	return level === INHERIT_THINKING ? undefined : (level as Effort);
}

export function resolveLiveConfig(settings: Settings): LiveConfig {
	const echoCancellationMode = parseMode(
		settings.get("live.echoCancellationMode"),
		LiveEchoCancellationMode,
		"live.echoCancellationMode",
	);
	const echoDelayMs = clamp(settings.get("live.echoDelayMs"), 0, 500);
	if (echoCancellationMode === LiveEchoCancellationMode.Mobile && echoDelayMs === 0) {
		throw new Error("live.echoDelayMs must be greater than zero when mobile echo cancellation is selected");
	}
	return {
		model: (settings.get("live.model") ?? "").trim() || "gpt-live-1-codex",
		codingModel: (settings.get("live.codingModel") ?? "").trim(),
		codingThinkingLevel: concreteLiveEffort(settings.get("live.codingThinkingLevel")),
		voice: settings.get("live.voice"),
		connectTimeoutMs: clamp(settings.get("live.connectTimeoutMs"), 1, 60_000),
		sidebandConnectAttempts: clamp(settings.get("live.sidebandConnectAttempts"), 1, 8),
		inactivityTimeoutMinutes: clamp(settings.get("live.inactivityTimeoutMinutes"), 0, 60),
		outputActiveLevel: clamp(settings.get("live.outputActiveLevel"), 0, 1),
		vadStartRms: clamp(settings.get("live.vadStartRms"), 0, 1),
		echoCancellationMode,
		echoDelayMs,
		noiseSuppressionLevel: parseMode(
			settings.get("live.noiseSuppressionLevel"),
			LiveNoiseSuppressionLevel,
			"live.noiseSuppressionLevel",
		),
		agcMode: parseMode(settings.get("live.agcMode"), LiveAgcMode, "live.agcMode"),
		agcTargetLevelDbfs: clamp(settings.get("live.agcTargetLevelDbfs"), 0, 31),
		agcCompressionGainDb: clamp(settings.get("live.agcCompressionGainDb"), 0, 90),
		agcLimiter: settings.get("live.agcLimiter"),
		inputDeviceId: (settings.get("live.inputDeviceId") ?? "").trim(),
		outputDeviceId: (settings.get("live.outputDeviceId") ?? "").trim(),
		includeContinuity: settings.get("live.includeContinuity"),
		continuityMaxItems: clamp(settings.get("live.continuityMaxItems"), 1, 128),
		continuityMaxTokens: clamp(settings.get("live.continuityMaxTokens"), 1, 8192),
		handoffFlushMs: clamp(settings.get("live.handoffFlushMs"), 1, 10_000),
		flushTranscriptTail: settings.get("live.flushTranscriptTail"),
		computerUse: settings.get("live.computerUse"),
	};
}
