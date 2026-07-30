import { describe, expect, it } from "bun:test";
import { buildLiveSidebandUrl, LiveEndError, parseLiveCallId, retryLiveSideband } from "./transport";

describe("live transport contracts", () => {
	it("extracts only rtc call IDs from signaling locations", () => {
		expect(parseLiveCallId("https://api.openai.com/v1/realtime/calls/rtc_abc-123?token=secret")).toBe("rtc_abc-123");
		expect(parseLiveCallId("https://api.openai.com/v1/realtime/calls/not-a-call")).toBeUndefined();
		expect(parseLiveCallId(null)).toBeUndefined();
	});

	it("builds an encoded Frameless sideband URL", () => {
		expect(buildLiveSidebandUrl("rtc_abc-123")).toBe("wss://api.openai.com/v1/live/rtc_abc-123");
	});

	it.each(["sideband_lost", "inactivity"] as const)("preserves %s and offers a fresh session", reason => {
		expect(new LiveEndError(reason, "closed")).toMatchObject({
			name: "LiveEndError",
			reason,
			message: "closed. Run /live to start a fresh session.",
		});
	});
	it("retries exactly until the configured attempt succeeds", async () => {
		let attempts = 0;
		const delays: number[] = [];

		await retryLiveSideband(
			5,
			undefined,
			async () => {
				attempts += 1;
				if (attempts < 3) throw new Error("join failed");
			},
			async delayMs => {
				delays.push(delayMs);
			},
		);

		expect(attempts).toBe(3);
		expect(delays).toEqual([200, 400]);
	});

	it("does not start another attempt when aborted during backoff", async () => {
		const abort = new AbortController();
		let attempts = 0;
		const connecting = retryLiveSideband(5, abort.signal, async () => {
			attempts += 1;
			throw new Error("join failed");
		});
		setTimeout(() => abort.abort(), 10);

		const error = await connecting.catch((cause: unknown) => cause);

		expect(error).toMatchObject({ name: "AbortError" });
		expect(attempts).toBe(1);
	});
});
