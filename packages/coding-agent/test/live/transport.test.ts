import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { AuthStorage, resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai/auth-storage";
import { OPENAI_HEADERS } from "@oh-my-pi/pi-catalog/wire/codex";
import * as natives from "@oh-my-pi/pi-natives";
import { buildSessionClose, buildSessionContextAppend, type LiveServerEvent } from "../../src/live/protocol";
import { CodexLiveTransport, type LiveTransportOptions } from "../../src/live/transport";

/** Codex's first sideband reconnect backoff. */
const FIRST_RECONNECT_DELAY_MS = 200;

class FakePeer {
	readonly muted: boolean[] = [];
	/** Resolved when the transport waits for the data channel, after the answer was applied. */
	readonly waiting = Promise.withResolvers<void>();
	/** Resolved by the test to open the data channel. */
	readonly open = Promise.withResolvers<void>();
	closed = false;

	async createOffer(): Promise<string> {
		return "v=0 offer";
	}

	async acceptAnswer(_sdp: string): Promise<void> {}

	waitForOpen(): Promise<void> {
		this.waiting.resolve();
		return this.open.promise;
	}

	setMuted(muted: boolean): void {
		this.muted.push(muted);
	}

	setSpeakerSuppressed(_suppressed: boolean): void {}

	async close(): Promise<void> {
		this.closed = true;
	}
}

const sockets: FakeWebSocket[] = [];
const socketWaiters: Array<() => void> = [];

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = FakeWebSocket.CONNECTING;
	binaryType = "blob";
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number; reason: string }) => void) | null = null;
	/** Frames written by the client, then `close:<code>` when the client closes the socket. */
	readonly log: string[] = [];

	constructor(
		readonly url: string,
		readonly options?: Bun.WebSocketOptions,
	) {
		sockets.push(this);
		for (const wake of socketWaiters.splice(0)) wake();
	}

	send(data: string): void {
		this.log.push(data);
	}

	close(code = 1000, reason = ""): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.log.push(`close:${code}`);
		queueMicrotask(() => this.onclose?.({ code, reason }));
	}

	accept(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	closeFromServer(code: number, reason = ""): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason });
	}
}

async function socketAt(index: number): Promise<FakeWebSocket> {
	for (;;) {
		const socket = sockets[index];
		if (socket) return socket;
		const { promise, resolve } = Promise.withResolvers<void>();
		socketWaiters.push(resolve);
		await promise;
	}
}

/** Backoff sleeps the transport requested; each stays pending until the test releases it. */
const sleeps: Array<{ ms: number; release: () => void }> = [];

/** Runs every queued continuation, so a dial the transport would still make has happened. */
function drainContinuations(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

const authStorage = {
	oauth: { access: async () => ({ accessToken: "test-token", accountId: "test-account" }) },
	limits: { rotate: async () => ({ switched: false }) },
} as unknown as AuthStorage;

function setup(options: Partial<Pick<LiveTransportOptions, "authStorage" | "sessionId" | "authSessionId">> = {}) {
	const peer = new FakePeer();
	spyOn(natives, "LiveWebRtcPeer").mockImplementation(function () {
		return peer;
	} as never);
	const events: LiveServerEvent[] = [];
	let ended = 0;
	const transport = new CodexLiveTransport({
		authStorage,
		sessionId: "session-1",
		...options,
		instructions: "Be brief.",
		voice: "sol",
		callbacks: {
			onEvent: event => events.push(event),
			onLevels: () => {},
			onEnded: () => {
				ended += 1;
			},
		},
	});
	return { transport, peer, events, ended: () => ended };
}

async function connected(harness = setup()) {
	const connecting = harness.transport.connect();
	await harness.peer.waiting.promise;
	harness.peer.open.resolve();
	const socket = await socketAt(0);
	socket.accept();
	await connecting;
	return { ...harness, socket };
}

function speakable(text: string) {
	return buildSessionContextAppend(text, "speakable");
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
	sockets.length = 0;
	socketWaiters.length = 0;
	sleeps.length = 0;
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		sleeps.push({ ms, release: resolve });
		return promise;
	}) as typeof Bun.sleep);
	spyOn(natives, "deviceCheckGenerateToken").mockResolvedValue({ supported: false, latencyMs: 0 });
	spyOn(globalThis, "fetch").mockImplementation(
		(async () =>
			new Response("v=0 answer", {
				status: 201,
				headers: { location: "/v1/realtime/calls/rtc_test-call" },
			})) as unknown as typeof fetch,
	);
});

afterEach(() => {
	globalThis.WebSocket = originalWebSocket;
	vi.restoreAllMocks();
});

describe("CodexLiveTransport connect", () => {
	test("a mute toggled while connecting reaches the native peer before the call connects", async () => {
		const { transport, peer } = setup();
		const connecting = transport.connect();
		await peer.waiting.promise;
		expect(peer.muted).toEqual([false]);

		await transport.setMuted(true);
		await transport.setMuted(false);
		await transport.setMuted(true);
		expect(peer.muted).toEqual([false, true, false, true]);

		peer.open.resolve();
		(await socketAt(0)).accept();
		await connecting;
		expect(peer.muted.at(-1)).toBe(true);
		await transport.close();
	});

	test("closing while the sideband connects closes that socket and dials no more", async () => {
		const { transport, peer } = setup();
		const outcome = transport.connect().then(
			() => undefined,
			(error: Error) => error,
		);
		await peer.waiting.promise;
		peer.open.resolve();
		const socket = await socketAt(0);

		await transport.close();
		expect(socket.log).toEqual(["close:1000"]);
		expect((await outcome)?.name).toBe("AbortError");
		expect(peer.closed).toBe(true);
		expect(sleeps).toEqual([]);
		expect(sockets).toHaveLength(1);
	});
});

describe("CodexLiveTransport sideband close codes", () => {
	test("a normal server close ends the session without reconnecting", async () => {
		const { transport, peer, socket, events, ended } = await connected();

		socket.closeFromServer(1000, "session ended");
		expect(ended()).toBe(1);
		expect(peer.closed).toBe(true);
		await drainContinuations();
		expect(sleeps).toEqual([]);
		expect(sockets).toHaveLength(1);
		expect(events).toEqual([]);
		await expect(transport.send(speakable("late"))).rejects.toThrow("Live transport is not connected");
	});

	test("an abnormal close rejoins the call and delivers messages sent meanwhile, in order", async () => {
		const { transport, socket, events } = await connected();

		socket.closeFromServer(1006);
		const delivered: string[] = [];
		const first = transport.send(speakable("first")).then(() => delivered.push("first"));
		const second = transport.send(speakable("second")).then(() => delivered.push("second"));
		expect(sleeps.map(sleep => sleep.ms)).toEqual([FIRST_RECONNECT_DELAY_MS]);
		sleeps[0]?.release();
		const rejoined = await socketAt(1);
		await drainContinuations();
		expect(delivered).toEqual([]);

		rejoined.accept();
		await Promise.all([first, second]);
		await transport.send(speakable("third"));
		expect(delivered).toEqual(["first", "second"]);
		expect(rejoined.log).toEqual(["first", "second", "third"].map(text => JSON.stringify(speakable(text))));
		expect(socket.log).toEqual([]);
		expect(events).toEqual([]);
		await transport.close();
	});

	test("rejoin resolves fresh OAuth credentials instead of reusing the initial bearer", async () => {
		let generation = 0;
		const access = spyOn(authStorage.oauth, "access").mockImplementation(async () => ({
			accessToken: `token-${++generation}`,
			accountId: "test-account",
		}));
		const { transport, socket } = await connected();
		expect(access).toHaveBeenCalledTimes(1);

		socket.closeFromServer(1006);
		sleeps[0]?.release();
		const rejoined = await socketAt(1);
		rejoined.accept();
		await drainContinuations();

		expect(access).toHaveBeenCalledTimes(2);
		const headers = rejoined.options?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer token-2");
		await transport.close();
	});

	test("rejoin keeps the local OAuth owner when the shared wire session changes accounts", async () => {
		const storage = await AuthStorage.create(":memory:", {
			usageProviderResolver: () => undefined,
			rankingStrategyResolver: () => undefined,
		});
		let transport: CodexLiveTransport | undefined;
		try {
			const provider = "openai-codex";
			const sessionId = "shared-wire-session";
			const authSessionId = "local-auth-owner";
			const expires = Date.now() + 3_600_000;
			const credentialB = {
				type: "oauth" as const,
				access: "live-access-b",
				refresh: "live-refresh-b",
				expires,
				accountId: "live-account-b",
			};
			await storage.credentials.set(provider, [
				{
					type: "oauth",
					access: "live-access-a",
					refresh: "live-refresh-a",
					expires,
					accountId: "live-account-a",
				},
				credentialB,
			]);
			const accounts = storage.oauth.accounts(provider);
			const accountA = accounts.find(account => account.accountId === "live-account-a");
			const accountB = accounts.find(account => account.accountId === "live-account-b");
			const ownerIdentity = resolveCredentialIdentityKey(provider, credentialB);
			if (!accountA || !accountB || !ownerIdentity) throw new Error("Expected two identified fake OAuth accounts");
			storage.sessions.restrict(provider, authSessionId, [ownerIdentity]);
			expect(storage.sessions.pin(provider, authSessionId, accountB.credentialId)).toBe(true);
			expect(storage.sessions.pin(provider, sessionId, accountB.credentialId)).toBe(true);

			const signaling = spyOn(globalThis, "fetch");
			const harness = setup({ authStorage: storage, sessionId, authSessionId });
			transport = harness.transport;
			const { socket } = await connected(harness);
			expect(signaling).toHaveBeenCalledTimes(1);
			const signalingHeaders = new Headers(signaling.mock.calls[0]?.[1]?.headers);
			expect(signalingHeaders.get("Authorization")).toBe("Bearer live-access-b");
			expect(signalingHeaders.get(OPENAI_HEADERS.SCOPED_SESSION_ID)).toBe(sessionId);
			expect(signalingHeaders.get(OPENAI_HEADERS.THREAD_ID)).toBe(sessionId);
			const initialHeaders = socket.options?.headers as Record<string, string>;
			expect(initialHeaders.Authorization).toBe("Bearer live-access-b");
			expect(initialHeaders[OPENAI_HEADERS.SCOPED_SESSION_ID]).toBe(sessionId);
			expect(initialHeaders[OPENAI_HEADERS.THREAD_ID]).toBe(sessionId);

			// Only the shared store's pin changes; this call's local owner stays restricted to B.
			expect(storage.sessions.pin(provider, sessionId, accountA.credentialId)).toBe(true);
			expect(storage.oauth.identity(provider, sessionId)?.accountId).toBe("live-account-a");
			expect(storage.oauth.identity(provider, authSessionId)?.accountId).toBe("live-account-b");
			socket.closeFromServer(1006);
			sleeps[0]?.release();
			const rejoined = await socketAt(1);
			rejoined.accept();
			await drainContinuations();

			const headers = rejoined.options?.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer live-access-b");
			expect(headers[OPENAI_HEADERS.SCOPED_SESSION_ID]).toBe(sessionId);
			expect(headers[OPENAI_HEADERS.THREAD_ID]).toBe(sessionId);
			expect(storage.oauth.identity(provider, authSessionId)?.accountId).toBe("live-account-b");
		} finally {
			try {
				await transport?.close();
			} finally {
				storage.close();
			}
		}
	});
});

describe("CodexLiveTransport close", () => {
	test("a message waiting for the sideband to rejoin rejects when the transport closes first", async () => {
		const { transport, peer, socket } = await connected();

		socket.closeFromServer(1006);
		const outcome = transport.send(speakable("unsent")).then(
			() => "delivered",
			(error: Error) => error.message,
		);
		await transport.close();
		expect(await outcome).toBe("Live transport closed before the message was sent");
		expect(peer.closed).toBe(true);

		// The rejoin was waiting out its backoff; once released it must not dial a closed call.
		sleeps[0]?.release();
		await drainContinuations();
		expect(sockets).toHaveLength(1);
	});

	test("closing an open call sends session.close before closing the sideband", async () => {
		const { transport, peer, socket } = await connected();

		await transport.close();
		expect(socket.log).toEqual([JSON.stringify(buildSessionClose()), "close:1000"]);
		expect(peer.closed).toBe(true);
	});
});
