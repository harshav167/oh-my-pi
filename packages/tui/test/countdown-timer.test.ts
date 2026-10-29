import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { CountdownTimer } from "@oh-my-pi/pi-tui/chrome/countdown-timer";

describe("CountdownTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("expires using precise sub-second timeout instead of second rounding", () => {
		const onTick = vi.fn();
		const onExpire = vi.fn();
		new CountdownTimer(250, undefined, onTick, onExpire);

		expect(onTick).toHaveBeenCalledWith(1);
		vi.advanceTimersByTime(249);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("reset restarts precise timeout window", () => {
		const onExpire = vi.fn();
		const timer = new CountdownTimer(300, undefined, () => {}, onExpire);

		vi.advanceTimersByTime(200);
		timer.reset();
		vi.advanceTimersByTime(299);
		expect(onExpire).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});

	it("pause preserves the remaining window and ignores resets until resumed", () => {
		const onExpire = vi.fn();
		const timer = new CountdownTimer(1_000, undefined, () => {}, onExpire);

		vi.advanceTimersByTime(400);
		timer.pause();
		timer.reset();
		vi.advanceTimersByTime(5_000);
		expect(onExpire).not.toHaveBeenCalled();

		timer.resume();
		vi.advanceTimersByTime(599);
		expect(onExpire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onExpire).toHaveBeenCalledTimes(1);
	});
});
