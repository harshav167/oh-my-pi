import { type AuthStorage, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { logger, toError } from "@oh-my-pi/pi-utils";
import { generateCodexAttestation } from "./attestation";
import {
	buildLiveSessionPayload,
	buildSessionClose,
	type LiveClientMessage,
	type LiveServerEvent,
	parseLiveServerEvent,
} from "./protocol";

const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
/** Codex's sideband reconnect backoff (`core/src/realtime_conversation/sideband.rs`). */
const RECONNECT_BASE_DELAY_MS = 200;
const RECONNECT_MAX_DELAY_MS = 5_000;
const STABLE_CONNECTION_MS = 30_000;
/** The server ended the session: Codex treats it as the conversation ending, not a dropped connection. */
const NORMAL_CLOSE_CODE = 1000;
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

interface PendingOutbound {
	message: LiveClientMessage;
	resolve(): void;
	reject(error: Error): void;
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

/** Startup failed after signaling: negotiation timed out or the connection closed. Codex retries these once. */
export class LiveStartupInterruptedError extends Error {
	readonly timedOut: boolean;

	constructor(message: string, timedOut: boolean) {
		super(message);
		this.name = "LiveStartupInterruptedError";
		this.timedOut = timedOut;
	}
}

function startupInterruption(cause: unknown): LiveStartupInterruptedError {
	const message = toError(cause).message;
	return new LiveStartupInterruptedError(message, /timed out/i.test(message));
}

/** Callbacks emitted by the live WebRTC transport. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	/** Microphone and speaker RMS levels reported by the native peer, clamped to [0, 1]. */
	onLevels(input: number, output: number): void;
	/** The server ended the session normally; the transport has started closing. */
	onEnded(): void;
}

/** Configuration required to establish a Codex live call. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	sessionId: string;
	/** Local credential owner, distinct from the provider-facing session id when supplied. */
	authSessionId?: string;
	instructions: string;
	voice: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
	/**
	 * SDP offer from a caller-owned WebRTC peer (one Opus audio track plus an `oai-events`
	 * data channel). When set, no native peer is created: the caller's peer carries the audio,
	 * {@link CodexLiveTransport.sdpAnswer} holds the answer to apply to it, and this transport
	 * keeps only the sideband.
	 */
	sdpOffer?: string;
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

function abortReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("Live connection aborted", "AbortError");
}

function clampUnit(level: number): number {
	return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
}

/** WebRTC transport for a Codex Frameless Bidi live session, with a native or caller-owned media peer. */
export class CodexLiveTransport {
	readonly #options: LiveTransportOptions;
	#peer: LiveWebRtcPeer | undefined;
	#sdpAnswer: string | undefined;
	readonly #realtimeSessionId = crypto.randomUUID();
	#sideband: Bun.WebSocket | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#muted = false;
	#unexpectedFailureReported = false;
	/** Signaled call the sideband joins; kept to rejoin after a dropped connection. */
	#call: Omit<LiveSignalingResult, "answer"> | undefined;
	#reconnecting = false;
	#rapidDisconnects = 0;
	#sidebandConnectedAt = 0;
	/** Messages sent while the sideband rejoins; delivered in order once it reconnects. */
	#pendingOutbound: PendingOutbound[] = [];
	/** Cancels the sideband socket that is still connecting, so closing cannot leak it. */
	#cancelSidebandConnect: ((error: Error) => void) | undefined;
	readonly #abortListener: () => void;

	constructor(options: LiveTransportOptions) {
		this.#options = options;
		this.#abortListener = () => {
			void this.close();
		};
		if (!options.signal?.aborted) options.signal?.addEventListener("abort", this.#abortListener, { once: true });
	}

	/** SDP answer for the caller's peer once a {@link LiveTransportOptions.sdpOffer} call has been signaled. */
	get sdpAnswer(): string | undefined {
		return this.#sdpAnswer;
	}

	/** Establish the media peer, perform Codex signaling, and wait for the data channel or sideband. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#isClosing()) return Promise.reject(new Error("Live transport is closed"));
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
		let offer = this.#options.sdpOffer;
		let peer: LiveWebRtcPeer | undefined;
		if (offer === undefined) {
			peer = this.#createPeer();
			this.#peer = peer;
			offer = await peer.createOffer();
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		const signaling = await this.#signal(offer);
		if (peer) {
			await peer.acceptAnswer(signaling.answer);
			peer.setMuted(this.#muted);
		} else {
			this.#sdpAnswer = signaling.answer;
		}
		try {
			if (peer) await peer.waitForOpen();
			if (this.#state !== "connecting") throw abortReason(this.#options.signal);
			await this.#connectSideband(signaling.callId, signaling.access, signaling.attestation);
		} catch (cause) {
			if (this.#state !== "connecting") throw abortReason(this.#options.signal);
			throw startupInterruption(cause);
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		this.#call = { callId: signaling.callId, access: signaling.access, attestation: signaling.attestation };
		this.#sidebandConnectedAt = Date.now();
		this.#state = "connected";
	}

	#createPeer(): LiveWebRtcPeer {
		return new LiveWebRtcPeer(
			(error, payload) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleServerEvent(payload);
				}
			},
			(error, levels) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleLevels(levels.input, levels.output);
				}
			},
			(error, message) => this.#reportFailure(error?.message ?? message),
		);
	}

	async #signal(offer: string): Promise<LiveSignalingResult> {
		const attestation = await generateCodexAttestation();
		return await withOAuthAccess(
			this.#options.authStorage,
			LIVE_PROVIDER,
			access => this.#signalWithAccess(offer, access, attestation),
			{
				sessionId: this.#options.authSessionId ?? this.#options.sessionId,
				signal: this.#options.signal,
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
				session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice),
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
		let failure = new Error("Codex live sideband connection failed");
		for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
			if (this.#isClosing()) throw abortReason(this.#options.signal);
			try {
				await this.#openSideband(callId, access, attestation);
				return;
			} catch (cause) {
				failure = toError(cause);
				if (this.#isClosing()) throw abortReason(this.#options.signal);
				if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await Bun.sleep(200 * 2 ** attempt);
			}
		}
		throw failure;
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
		const settle = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (this.#cancelSidebandConnect === cancel) this.#cancelSidebandConnect = undefined;
			if (error) reject(error);
			else resolve();
		};
		const cancel = (error: Error): void => {
			socket.close(1000, "cancelled");
			settle(error);
		};
		socket.onopen = () => {
			if (settled) {
				socket.close(1000, "stale");
				return;
			}
			if (this.#isClosing()) {
				cancel(abortReason(this.#options.signal));
				return;
			}
			opened = true;
			this.#sideband = socket;
			settle();
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
				settle(new Error(`Codex live sideband connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			// The close that follows decides between reconnecting and failing.
			logger.debug("Codex live sideband error", { detail });
		};
		socket.onclose = event => {
			if (!opened) {
				settle(new Error(`Codex live sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.#sideband !== socket) return;
			this.#sideband = undefined;
			this.#handleSidebandClose(event.code, event.reason);
		};
		const timeout = setTimeout(() => {
			cancel(new Error("Codex live sideband connection timed out"));
		}, SIDEBAND_CONNECT_TIMEOUT_MS);
		timeout.unref?.();
		this.#cancelSidebandConnect = cancel;
		await promise;
	}

	/** Codex ends the session on a normal close and rejoins after any other (`realtime_websocket/methods.rs` close handling). */
	#handleSidebandClose(code: number, reason: string): void {
		const message = `Codex live sideband closed (${code})${reason ? `: ${reason}` : ""}`;
		if (this.#state === "connecting") {
			this.#reportFailure(message);
			return;
		}
		if (this.#state !== "connected") return;
		if (code === NORMAL_CLOSE_CODE) {
			logger.debug("Codex live session ended by the server");
			void this.close();
			try {
				this.#options.callbacks.onEnded();
			} catch {}
		} else {
			void this.#reconnectSideband(message);
		}
	}

	#handleSidebandEvent(payload: string): void {
		if (this.#isClosing()) return;
		const event = parseLiveServerEvent(payload);
		if (!event) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleServerEvent(payload: string): void {
		if (this.#isClosing()) return;
		const event = parseLiveServerEvent(payload);
		if (!event) return;
		if (this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error") return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleLevels(input: number, output: number): void {
		if (this.#state !== "connected") return;
		try {
			this.#options.callbacks.onLevels(clampUnit(input), clampUnit(output));
		} catch {}
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

	/** Rejoins the call's sideband after it dropped, with Codex's backoff; a failed rejoin ends the session. */
	async #reconnectSideband(reason: string): Promise<void> {
		const call = this.#call;
		if (!call) {
			this.#reportFailure(reason);
			return;
		}
		if (this.#reconnecting) return;
		this.#reconnecting = true;
		if (Date.now() - this.#sidebandConnectedAt >= STABLE_CONNECTION_MS) this.#rapidDisconnects = 0;
		this.#rapidDisconnects += 1;
		const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (this.#rapidDisconnects - 1), RECONNECT_MAX_DELAY_MS);
		logger.warn("Codex live sideband lost; reconnecting", { reason, delayMs });
		try {
			await Bun.sleep(delayMs);
			if (this.#state !== "connected") return;
			await withOAuthAccess(
				this.#options.authStorage,
				LIVE_PROVIDER,
				access => this.#connectSideband(call.callId, access, call.attestation),
				{
					sessionId: this.#options.authSessionId ?? this.#options.sessionId,
					signal: this.#options.signal,
				},
			);
		} catch (cause) {
			this.#reconnecting = false;
			if (this.#state === "connected") this.#reportFailure(`${reason}; reconnect failed: ${toError(cause).message}`);
			return;
		}
		this.#reconnecting = false;
		if (this.#state !== "connected") return;
		this.#sidebandConnectedAt = Date.now();
		const sideband = this.#sideband;
		if (!sideband) return;
		for (const pending of this.#pendingOutbound.splice(0)) {
			try {
				sideband.send(JSON.stringify(pending.message));
				pending.resolve();
			} catch (cause) {
				pending.reject(toError(cause));
			}
		}
	}

	/**
	 * Send one Frameless Bidi control message on the call's sideband WebSocket. While the sideband
	 * rejoins, the message waits and settles once delivered, or rejects if the transport closes first.
	 */
	async send(message: LiveClientMessage): Promise<void> {
		if (this.#state !== "connected") throw new Error("Live transport is not connected");
		const sideband = this.#sideband;
		// Behind earlier queued messages too, so delivery keeps the order they were sent in.
		if (!sideband || sideband.readyState !== WebSocket.OPEN || this.#pendingOutbound.length > 0) {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			this.#pendingOutbound.push({ message, resolve, reject });
			return promise;
		}
		sideband.send(JSON.stringify(message));
	}

	#isClosing(): boolean {
		return this.#state === "closing" || this.#state === "closed";
	}

	/** Drops queued speaker audio, and keeps dropping new audio, until unsuppressed. */
	setSpeakerSuppressed(suppressed: boolean): void {
		this.#peer?.setSpeakerSuppressed(suppressed);
	}

	/** Enable or disable the native audio source and discard partial input when muted. */
	async setMuted(muted: boolean): Promise<void> {
		this.#muted = muted;
		// The native mute applies before media starts flowing, so connecting peers honor it too.
		this.#peer?.setMuted(muted);
	}

	/** End the session, stop sideband signaling, and close the native WebRTC media peer. Safe to call repeatedly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		this.#options.signal?.removeEventListener("abort", this.#abortListener);
		const unsent = new Error("Live transport closed before the message was sent");
		for (const pending of this.#pendingOutbound.splice(0)) pending.reject(unsent);
		this.#cancelSidebandConnect?.(abortReason(this.#options.signal));
		const sideband = this.#sideband;
		const peer = this.#peer;
		this.#sideband = undefined;
		this.#peer = undefined;
		if (sideband?.readyState === WebSocket.OPEN) {
			try {
				sideband.send(JSON.stringify(buildSessionClose()));
			} catch (cause) {
				logger.debug("Failed to send Codex live session.close", { error: toError(cause).message });
			}
			sideband.close(1000, "done");
		} else {
			// Closing the WebRTC peer ends the call without the sideband.
			logger.debug("Codex live sideband is not open; skipping session.close");
		}
		if (peer) {
			try {
				await peer.close();
			} catch {}
		}
		this.#state = "closed";
	}
}
