import {
	type Component,
	matchesKey,
	replaceTabs,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { type ThemeColor, theme } from "../modes/theme/theme";

/** Connection lifecycle shown in the visualizer footer. */
export type LiveConnectionPhase = "connecting" | "active" | "error" | "closed";
/** Whether the assistant is currently rendering speech. */
export type LiveVoiceState = "listening" | "speaking";
/** Whether a delegated backend turn is running. */
export type LiveWorkerState = "idle" | "working";

/** Orthogonal call state rendered by the visualizer. */
export interface LiveVisualizerState {
	readonly connection: LiveConnectionPhase;
	readonly voice: LiveVoiceState;
	readonly worker: LiveWorkerState;
	readonly inputMuted: boolean;
	readonly outputMuted: boolean;
}
/** Configuration callbacks for user interactions in the visualizer. */
export interface LiveVisualizerOptions {
	onStop(): void;
	onToggleMute(): void;
	onToggleOutputMute(): void;
	onRefreshMicrophone(): void;
	/** Restarts a call that failed to start; only reachable from the error state. */
	onRetry(): void;
}

function normalizeTranscript(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/\s+/g, " ").trim();
}

function truncateFromStart(text: string, width: number): string {
	if (width <= 0) return "";
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text;
	if (width === 1) return "…";
	return `…${sliceWithWidth(text, textWidth - width + 1, width - 1, true).text}`;
}

/** A compact, fixed-height terminal component for displaying a realtime call. */
export class LiveVisualizer implements Component {
	readonly wantsKeyRelease = false;

	readonly #options: LiveVisualizerOptions;

	#state: LiveVisualizerState = {
		connection: "connecting",
		voice: "listening",
		worker: "idle",
		inputMuted: false,
		outputMuted: false,
	};
	#inputLevel = 0;
	#displayLevel = 0;
	#frame = 0;
	#userTranscript = "";

	#cache:
		| {
				width: number;
				state: LiveVisualizerState;
				displayLevel: number;
				frame: number;
				userTranscript: string;
				lines: readonly string[];
		  }
		| undefined;

	constructor(options: LiveVisualizerOptions) {
		this.#options = options;
	}

	/** Replaces the orthogonal call state. */
	setState(state: LiveVisualizerState): void {
		const current = this.#state;
		if (
			current.connection === state.connection &&
			current.voice === state.voice &&
			current.worker === state.worker &&
			current.inputMuted === state.inputMuted &&
			current.outputMuted === state.outputMuted
		) {
			return;
		}
		this.#state = state;
		this.invalidate();
	}

	/** Updates the microphone volume level (0..1). */
	setInputLevel(level: number): void {
		const next = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
		if (this.#inputLevel === next) return;
		this.#inputLevel = next;
		if (next > this.#displayLevel) this.#displayLevel = next;
		this.invalidate();
	}

	/** Advances the spectrum animation and its peak decay. */
	setFrame(frame: number): void {
		const nextLevel = Math.max(this.#inputLevel, this.#displayLevel * 0.84);
		if (this.#frame !== frame || this.#displayLevel !== nextLevel) {
			this.#frame = frame;
			this.#displayLevel = nextLevel;
			this.invalidate();
		}
	}

	/** Updates the user's streaming voice transcript. */
	setTranscript(text: string): void {
		const normalized = normalizeTranscript(text);
		if (this.#userTranscript === normalized) return;
		this.#userTranscript = normalized;
		this.invalidate();
	}

	/** Clears the user's voice transcript row. */
	clearTranscript(): void {
		if (!this.#userTranscript) return;
		this.#userTranscript = "";
		this.invalidate();
	}

	/**
	 * Processes user keypresses.
	 *
	 * `r` is overloaded by call state: while a call is up it refreshes the
	 * microphone, and on a failed start it retries the connection. A failed start
	 * has no microphone to refresh, so the two never compete, and one key avoids
	 * teaching a second binding for a surface the user reaches only on error.
	 */
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.#options.onStop();
		} else if (matchesKey(data, "space")) {
			this.#options.onToggleMute();
		} else if (data === "o") {
			this.#options.onToggleOutputMute();
		} else if (data === "r") {
			if (this.#state.connection === "error") this.#options.onRetry();
			else this.#options.onRefreshMicrophone();
		}
	}

	/** Clears the render cache. */
	invalidate(): void {
		this.#cache = undefined;
	}

	/** Renders the microphone spectrum into a compact fixed-height panel. */
	render(width: number): readonly string[] {
		if (
			this.#cache &&
			this.#cache.width === width &&
			this.#cache.state === this.#state &&
			this.#cache.displayLevel === this.#displayLevel &&
			this.#cache.frame === this.#frame &&
			this.#cache.userTranscript === this.#userTranscript
		) {
			return this.#cache.lines;
		}

		const lines = this.#renderLines(width);
		this.#cache = {
			width,
			state: this.#state,
			displayLevel: this.#displayLevel,
			frame: this.#frame,
			userTranscript: this.#userTranscript,
			lines,
		};
		return lines;
	}

	#renderLines(maxWidth: number): readonly string[] {
		const width = Math.max(2, maxWidth);
		const innerWidth = width - 2;
		const border = (content: string): string =>
			theme.fg("border", "│") + content + (width > 1 ? theme.fg("border", "│") : "");
		const top = theme.fg("border", `┌${"─".repeat(innerWidth)}${width > 1 ? "┐" : ""}`);
		const spectrumColor: ThemeColor = this.#state.inputMuted
			? "dim"
			: this.#state.connection === "error"
				? "error"
				: "success";
		const spectrum = this.#generateSpectrum(innerWidth, 2);
		const spectrumRows = spectrum.map(row => border(theme.fg(spectrumColor, row)));
		const transcript = this.#renderTranscript(this.#userTranscript, innerWidth, border);
		return [top, ...spectrumRows, transcript, this.#renderFooter(width, innerWidth)];
	}

	#renderTranscript(transcript: string, innerWidth: number, border: (content: string) => string): string {
		const content = truncateFromStart(transcript, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return border(theme.fg("accent", content) + padding);
	}

	/**
	 * Renders connection, voice, and worker state side by side.
	 *
	 * Speaking and working are independent: the assistant answering while the
	 * coding agent works is the normal case, not a conflict to prioritize away.
	 */
	#renderFooter(width: number, innerWidth: number): string {
		const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const { connection, voice, worker, inputMuted, outputMuted } = this.#state;
		const connectionIcons: Record<LiveConnectionPhase, string> = {
			connecting: "○",
			active: "●",
			error: "!",
			closed: "×",
		};
		const connectionColors: Record<LiveConnectionPhase, ThemeColor> = {
			connecting: "dim",
			active: "success",
			error: "error",
			closed: "dim",
		};
		const icon = connection === "active" && inputMuted ? "×" : connectionIcons[connection];
		const activity = [
			connection === "active" ? (inputMuted ? "muted" : voice) : connection,
			worker === "working" ? `${spinners[this.#frame % spinners.length]} working` : "",
		]
			.filter(Boolean)
			.join(" · ");
		const muteState = `${inputMuted ? " · mic×" : ""}${outputMuted ? " · out×" : ""}`;
		const status = `${icon} ${activity}${muteState}`;
		// The error state has no microphone to refresh, so `r` is offered as the
		// recovery the user actually needs there.
		const controls = connection === "error" ? "r retry · esc back" : "space mic · o output · r refresh · esc end";
		const fullLabel = ` ${status} · ${controls} `;
		const shortLabel = ` ${status} `;
		const label =
			innerWidth >= visibleWidth(fullLabel) + 1
				? fullLabel
				: innerWidth >= visibleWidth(shortLabel) + 1
					? shortLabel
					: "";
		if (!label) {
			return theme.fg("border", `└${"─".repeat(innerWidth)}${width > 1 ? "┘" : ""}`);
		}
		const color: ThemeColor =
			connection === "active" && worker === "working" ? "warning" : connectionColors[connection];
		const remaining = Math.max(0, innerWidth - visibleWidth(label) - 1);
		return (
			theme.fg("border", "└─") +
			theme.fg(color, truncateToWidth(label, innerWidth - 1)) +
			theme.fg("border", `${"─".repeat(remaining)}${width > 1 ? "┘" : ""}`)
		);
	}

	#generateSpectrum(width: number, rows: number): string[] {
		const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
		const output = Array.from({ length: rows }, () => "");
		const energy = this.#state.inputMuted ? 0 : Math.min(1, Math.sqrt(this.#displayLevel * 5));
		const maxHeight = rows * (blocks.length - 1);
		for (let column = 0; column < width; column += 1) {
			const carrier = 0.5 + 0.5 * Math.sin(this.#frame * 0.43 + column * 0.71);
			const shimmer = 0.5 + 0.5 * Math.sin(this.#frame * 0.19 - column * 1.17);
			const height = Math.round(energy * (0.3 + carrier * 0.5 + shimmer * 0.2) * maxHeight);
			for (let row = 0; row < rows; row += 1) {
				const units = Math.max(0, Math.min(blocks.length - 1, height - (rows - row - 1) * 8));
				output[row] += blocks[units];
			}
		}
		return output;
	}
}
