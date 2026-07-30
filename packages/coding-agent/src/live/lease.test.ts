import { describe, expect, it } from "bun:test";
import { acquireLiveSessionLease } from "./lease";

describe("acquireLiveSessionLease", () => {
	it("rejects concurrent sessions and releases exactly once", () => {
		const release = acquireLiveSessionLease();
		try {
			expect(() => acquireLiveSessionLease()).toThrow("A live voice session is already active");
		} finally {
			release();
			release();
		}
		const nextRelease = acquireLiveSessionLease();
		nextRelease();
	});
});
