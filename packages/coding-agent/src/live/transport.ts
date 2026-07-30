import { scheduler } from "node:timers/promises";
import { type AuthStorage, isAuthRetryableError, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { type LiveAudioProcessingConfig, LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { logger, toError } from "@oh-my-pi/pi-utils";
import { generateCodexAttestation } from "./attestation";
import {
	buildLiveSessionPayload,
	type LiveClientMessage,
	type LiveInitialItem,
	type LiveServerEvent,
	parseLiveServerEvent,
} from "./protocol";

const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";
export type LiveEndReason = "inactivity" | "sideband_lost";

export class LiveEndError extends Error {
	override name = "LiveEndError";

	constructor(
		readonly reason: LiveEndReason,
		message: string,
	) {
		super(`${message}. Run /live to start a fresh session.`);
	}
}

interface LiveSignalingResult {
	answer: string;
	callId: string;
	access: OAuthAccess;
	attestation: string | undefined;
}

class LiveSignalingError extends Error {
	status: number;
	errorMessage: string;

	constructor(status: number, message: string) {
		super(message);
		this.name = "LiveSignalingError";
		this.status = status;
		this.errorMessage = message;
	}
}

/** Callbacks emitted by the live WebRTC transport. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onInputLevel(level: number): void;
	onOutputLevel(level: number): void;
	/** Fired once the server accepted the call and a session exists remotely. */
	onSignalingEstablished(): void;
	onTerminal(error: LiveEndError): void;
}

/** Configuration required to establish a Codex live call. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	sessionId: string;
	instructions: string;
	model: string;
	voice: string;
	initialItems: readonly LiveInitialItem[];
	audioProcessing: LiveAudioProcessingConfig;
	inputDeviceId: string;
	outputDeviceId: string;
	connectTimeoutMs: number;
	sidebandConnectAttempts: number;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
}

/** Extracts the server-assigned `rtc_*` call ID from a signaling Location header. */
export function parseLiveCallId(location: string | null): string | undefined {
	if (!location) return undefined;
	return location
		.split("?", 1)[0]
		?.split("/")
		.find(segment => LIVE_CALL_ID_PATTERN.test(segment));
}

/** Builds the Frameless Bidi sideband WebSocket URL for an accepted Codex call. */
export function buildLiveSidebandUrl(callId: string): string {
	const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
	url.protocol = "wss:";
	return url.toString();
}

function liveSessionHeaders(
	access: OAuthAccess,
	sessionId: string,
	realtimeSessionId: string,
	attestation: string | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${access.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
		"x-session-id": realtimeSessionId,
		[OPENAI_HEADERS.ORIGINATOR]: LIVE_ORIGINATOR,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		[OPENAI_HEADERS.SCOPED_SESSION_ID]: sessionId,
		[OPENAI_HEADERS.THREAD_ID]: sessionId,
	};
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	if (attestation) headers["x-oai-attestation"] = attestation;
	return headers;
}

function boundedErrorBody(body: string, statusText: string): string {
	const normalized = body.trim().replaceAll(/\s+/g, " ");
	if (!normalized) return statusText || "empty response body";
	if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function isAuthError(error: unknown): boolean {
	return isAuthRetryableError(error);
}

function abortReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("Live connection aborted", "AbortError");
}

type LiveSidebandWait = (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;

async function waitForSidebandRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	await scheduler.wait(delayMs, { signal });
}

/** @internal Retries only the initial sideband join; established calls never reconnect. */
export async function retryLiveSideband(
	attempts: number,
	signal: AbortSignal | undefined,
	open: () => Promise<void>,
	wait: LiveSidebandWait = waitForSidebandRetry,
): Promise<void> {
	let failure = new Error("Codex live sideband connection failed");
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await open();
			return;
		} catch (cause) {
			failure = cause instanceof Error ? cause : new Error(String(cause));
			if (signal?.aborted) throw abortReason(signal);
			if (attempt + 1 >= attempts) break;
			try {
				await wait(200 * 2 ** attempt, signal);
			} catch (waitCause) {
				if (signal?.aborted) throw abortReason(signal);
				throw waitCause;
			}
			if (signal?.aborted) throw abortReason(signal);
		}
	}
	throw failure;
}

/** Native WebRTC transport for a Codex Frameless Bidi live session. */
export class CodexLiveTransport {
	readonly #options: LiveTransportOptions;
	#peer: LiveWebRtcPeer | undefined;
	readonly #realtimeSessionId = crypto.randomUUID();
	#sideband: Bun.WebSocket | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#sendTail: Promise<void> = Promise.resolve();
	#muted = false;
	#outputMuted = false;
	#unexpectedFailureReported = false;
	readonly #abortListener: () => void;

	constructor(options: LiveTransportOptions) {
		this.#options = options;
		this.#abortListener = () => {
			void this.close();
		};
		if (!options.signal?.aborted) options.signal?.addEventListener("abort", this.#abortListener, { once: true });
	}

	/** Establish the native peer, perform Codex signaling, and wait for the data channel. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#state === "closing" || this.#state === "closed")
			return Promise.reject(new Error("Live transport is closed"));
		if (this.#options.signal?.aborted) return Promise.reject(abortReason(this.#options.signal));
		this.#state = "connecting";
		const operation = this.#connect().catch(async error => {
			await this.close();
			throw error;
		});
		this.#connectPromise = operation;
		return operation;
	}
	async #connect(): Promise<void> {
		const peer = new LiveWebRtcPeer(
			(error, payload) => {
				if (error) {
					this.#handlePeerFailure(error.message);
				} else {
					this.#handleServerEvent(payload);
				}
			},
			(error, level) => {
				if (error) {
					this.#handlePeerFailure(error.message);
				} else {
					this.#handleLevel(level, this.#options.callbacks.onInputLevel);
				}
			},
			(error, level) => {
				if (error) {
					this.#handlePeerFailure(error.message);
				} else {
					this.#handleLevel(level, this.#options.callbacks.onOutputLevel);
				}
			},
			(error, message) => this.#handlePeerFailure(error?.message ?? message),
			this.#options.audioProcessing,
			this.#options.inputDeviceId,
			this.#options.outputDeviceId,
		);
		this.#peer = peer;
		const offer = await peer.createOffer();
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		const signaling = await this.#signal(offer);
		// The server now holds a session for this call even if activation fails.
		try {
			this.#options.callbacks.onSignalingEstablished();
		} catch {}
		await peer.acceptAnswer(signaling.answer);
		peer.setMuted(this.#muted);
		peer.setOutputMuted(this.#outputMuted);
		await peer.waitForOpen(this.#options.connectTimeoutMs);
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		await this.#connectSideband(signaling.callId, signaling.access, signaling.attestation);
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		this.#state = "connected";
	}

	async #signal(offer: string): Promise<LiveSignalingResult> {
		const attestation = await generateCodexAttestation();
		return await withOAuthAccess(
			this.#options.authStorage,
			LIVE_PROVIDER,
			access => this.#signalWithAccess(offer, access, attestation),
			{
				sessionId: this.#options.sessionId,
				signal: this.#options.signal,
				isAuthError,
				missingAccessMessage: "No Codex OAuth credential is available for a live call.",
			},
		);
	}

	async #signalWithAccess(
		offer: string,
		access: OAuthAccess,
		attestation: string | undefined,
	): Promise<LiveSignalingResult> {
		const headers = new Headers({
			...liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId, attestation),
			Accept: "*/*",
			"Content-Type": "application/json",
		});
		const fetchImpl = wrapFetchForProxy(fetch, LIVE_PROVIDER);
		const response = await fetchImpl(SIGNALING_URL, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sdp: offer,
				session: buildLiveSessionPayload({
					instructions: this.#options.instructions,
					model: this.#options.model,
					voice: this.#options.voice,
					initialItems: this.#options.initialItems,
				}),
			}),
			signal: this.#options.signal,
		});
		const responseBody = await response.text();
		if (!response.ok) {
			const detail = boundedErrorBody(responseBody, response.statusText);
			throw new LiveSignalingError(response.status, `Codex live signaling failed (${response.status}): ${detail}`);
		}
		const answer = responseBody;
		if (!answer.trim())
			throw new LiveSignalingError(response.status, "Codex live signaling returned an empty SDP answer");
		const callId = parseLiveCallId(response.headers.get("location"));
		if (!callId) {
			throw new LiveSignalingError(response.status, "Codex live signaling returned no valid call ID");
		}
		return { answer, callId, access, attestation };
	}

	async #connectSideband(callId: string, access: OAuthAccess, attestation: string | undefined): Promise<void> {
		await retryLiveSideband(this.#options.sidebandConnectAttempts, this.#options.signal, () =>
			this.#openSideband(callId, access, attestation),
		);
	}

	async #openSideband(callId: string, access: OAuthAccess, attestation: string | undefined): Promise<void> {
		const url = buildLiveSidebandUrl(callId);
		const options = {
			headers: liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId, attestation),
			proxy: getProxyForUrl(LIVE_PROVIDER, new URL(url)),
		} satisfies Bun.WebSocketOptions;
		const socket: Bun.WebSocket = Reflect.construct(WebSocket, [url, options]);
		socket.binaryType = "nodebuffer";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			this.#options.signal?.removeEventListener("abort", onAbort);
		};
		const rejectConnect = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => {
			socket.close(1000, "aborted");
			rejectConnect(abortReason(this.#options.signal));
		};
		socket.onopen = () => {
			if (settled) {
				socket.close(1000, "stale");
				return;
			}
			opened = true;
			settled = true;
			cleanup();
			this.#sideband = socket;
			resolve();
		};
		socket.onmessage = event => {
			if (typeof event.data !== "string") {
				this.#reportFailure("Codex live sideband returned an unexpected binary frame.");
				return;
			}
			this.#handleSidebandEvent(event.data);
		};
		socket.onerror = event => {
			const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
			if (!opened) {
				rejectConnect(new Error(`Codex live sideband connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			this.#reportTerminal(new LiveEndError("sideband_lost", `Codex live sideband failed${detail}`));
		};
		socket.onclose = event => {
			if (!opened) {
				rejectConnect(new Error(`Codex live sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.#sideband !== socket) return;
			this.#sideband = undefined;
			if (this.#state === "connecting" || this.#state === "connected") {
				const detail = event.reason ? `: ${event.reason}` : "";
				this.#reportTerminal(
					new LiveEndError("sideband_lost", `Codex live sideband closed (${event.code})${detail}`),
				);
			}
		};
		if (this.#options.signal?.aborted) {
			onAbort();
		} else {
			this.#options.signal?.addEventListener("abort", onAbort, { once: true });
			timeout = setTimeout(() => {
				socket.close(1000, "connect timeout");
				rejectConnect(new Error("Codex live sideband connection timed out"));
			}, this.#options.connectTimeoutMs);
			timeout.unref?.();
		}
		await promise;
	}

	#handleSidebandEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleServerEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event || (this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error")) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleLevel(level: number, emit: (level: number) => void): void {
		if (this.#state !== "connected" || !Number.isFinite(level)) return;
		try {
			emit(Math.min(1, Math.max(0, level)));
		} catch {}
	}

	#reportTerminal(error: LiveEndError): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onTerminal(error);
		} catch {}
	}

	#handlePeerFailure(message: string): void {
		this.#reportFailure(message);
	}

	#reportFailure(message: string): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onEvent({ type: "error", message });
		} catch {}
	}

	/** Serialize one Frameless Bidi control message onto the call's sideband WebSocket. */
	send(message: LiveClientMessage): Promise<void> {
		const operation = this.#sendTail.then(() => {
			if (this.#state !== "connected") throw new Error("Live transport is not connected");
			const sideband = this.#sideband;
			if (!sideband || sideband.readyState !== WebSocket.OPEN) {
				throw new Error("Codex live sideband is not connected");
			}
			sideband.send(JSON.stringify(message));
		});
		this.#sendTail = operation.catch(() => {});
		return operation;
	}

	/** Release startup audio retained natively and begin transmitting. */
	activate(): void {
		if (this.#state !== "connected") return;
		this.#peer?.activate();
	}

	/** Reopen the microphone, optionally switching input device, mid-call. */
	refreshMicrophone(inputDeviceId: string): void {
		if (this.#state !== "connected") return;
		this.#peer?.refreshMicrophone(inputDeviceId);
	}

	/** Enable or disable the native audio source and discard partial input when muted. */
	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		if (this.#state === "connected") this.#peer?.setMuted(muted);
	}

	/** Mute speaker playback while preserving remote media and events. */
	async setOutputMuted(muted: boolean): Promise<void> {
		this.#outputMuted = muted;
		if (this.#state === "connected") this.#peer?.setOutputMuted(muted);
	}

	/** Stop sideband signaling and the native WebRTC media peer. Safe to call repeatedly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		this.#options.signal?.removeEventListener("abort", this.#abortListener);
		const sideband = this.#sideband;
		const peer = this.#peer;
		this.#sideband = undefined;
		this.#peer = undefined;
		if (sideband && (sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)) {
			sideband.close(1000, "done");
		}
		try {
			// Native close is what snapshots the final playback counters off the
			// render writer, so diagnostics are only final afterwards.
			if (peer) await peer.close();
		} finally {
			if (peer) this.#logDiagnostics(peer);
			this.#state = "closed";
		}
	}

	/**
	 * Log this call's media counters once.
	 *
	 * Deliberately carries no SDP, authorization, attestation, PCM, transcript,
	 * or wire frame — only counters and the sanitized codec summary the native
	 * peer captured after negotiation.
	 */
	#logDiagnostics(peer: LiveWebRtcPeer): void {
		try {
			logger.debug("Live call media diagnostics", { ...peer.getDiagnostics() });
		} catch (cause) {
			logger.debug("Live call media diagnostics unavailable", { error: toError(cause).message });
		}
	}
}
