import type { AdvisorConsultRequest } from "./consultation";

export interface AdvisorReviewJob {
	readonly kind: "review";
	readonly text: string;
	readonly turns: number;
	/** Primary was mid-turn when this delta was rendered (main willContinue). */
	readonly wip?: boolean;
}

interface AdvisorConsultJob {
	readonly kind: "consult";
	readonly request: AdvisorConsultRequest;
	readonly resolve: (value: { readonly reply: string }) => void;
	readonly reject: (error: unknown) => void;
	removeQueuedAbort?: () => void;
	settled: boolean;
}

type AdvisorQueueJob = AdvisorReviewJob | AdvisorConsultJob;

export interface AdvisorConsultationQueueCallbacks {
	readonly runReviews: (reviews: readonly AdvisorReviewJob[]) => Promise<void>;
	readonly runConsult: (request: AdvisorConsultRequest) => Promise<{ readonly reply: string }>;
	readonly abortConsult: (reason: unknown) => void;
	readonly markToolCallSeen: (toolCallId: string) => void;
	readonly unmarkToolCallSeen: (toolCallId: string) => void;
}

export class AdvisorConsultationQueue {
	#jobs: AdvisorQueueJob[] = [];
	#inFlightConsult: AdvisorConsultJob | undefined;
	#busy = false;
	#disposed = false;

	constructor(private readonly callbacks: AdvisorConsultationQueueCallbacks) {}

	enqueueReview(text: string, turns: number, wip = false): void {
		if (this.#disposed) return;
		this.#jobs.push({ kind: "review", text, turns, wip });
		void this.#drain();
	}

	prependReview(text: string, turns: number): void {
		if (this.#disposed) return;
		this.#jobs.unshift({ kind: "review", text, turns });
	}

	consult(request: AdvisorConsultRequest): Promise<{ readonly reply: string }> {
		if (this.#disposed) return Promise.reject(new Error("Advisor disposed"));
		if (request.signal?.aborted) return Promise.reject(abortError(request.signal));

		const { promise, resolve, reject } = Promise.withResolvers<{ readonly reply: string }>();
		const job: AdvisorConsultJob = {
			kind: "consult",
			request,
			resolve,
			reject,
			settled: false,
		};
		this.#jobs.push(job);
		if (request.signal) {
			const signal = request.signal;
			const onAbort = (): void => {
				const index = this.#jobs.indexOf(job);
				if (index < 0) return;
				this.#jobs.splice(index, 1);
				this.#settle(job, { error: abortError(signal) });
			};
			signal.addEventListener("abort", onAbort, { once: true });
			job.removeQueuedAbort = () => signal.removeEventListener("abort", onAbort);
		}
		void this.#drain();
		return promise;
	}

	queuedReviewTurns(): number {
		return this.#jobs.reduce((sum, job) => sum + (job.kind === "review" ? job.turns : 0), 0);
	}

	clearReviews(): number {
		const turns = this.queuedReviewTurns();
		this.#jobs = this.#jobs.filter(job => job.kind === "consult");
		return turns;
	}

	rejectConsults(error: Error): void {
		const remaining = this.#jobs.splice(0);
		for (const job of remaining) {
			if (job.kind === "consult") this.#settle(job, { error });
		}
		const inFlight = this.#inFlightConsult;
		if (inFlight) this.#settle(inFlight, { error });
	}

	dispose(error: Error): void {
		this.#disposed = true;
		this.rejectConsults(error);
		this.#jobs = [];
	}

	async #drain(): Promise<void> {
		if (this.#busy) return;
		this.#busy = true;
		try {
			while (!this.#disposed && this.#jobs.length > 0) {
				const head = this.#jobs[0];
				if (head.kind === "review") {
					const reviews: AdvisorReviewJob[] = [];
					while (this.#jobs[0]?.kind === "review") {
						const review = this.#jobs.shift();
						if (review?.kind === "review") reviews.push(review);
					}
					await this.callbacks.runReviews(reviews);
					continue;
				}

				const job = this.#jobs.shift();
				if (job?.kind !== "consult") continue;
				job.removeQueuedAbort?.();
				this.#inFlightConsult = job;
				const toolCallId = job.request.toolCallId;
				if (toolCallId) this.callbacks.markToolCallSeen(toolCallId);
				let removeAbort: (() => void) | undefined;
				try {
					const signal = job.request.signal;
					if (signal?.aborted) throw abortError(signal);
					if (signal) {
						const onAbort = (): void => this.callbacks.abortConsult(signal.reason ?? "consult aborted");
						signal.addEventListener("abort", onAbort, { once: true });
						removeAbort = () => signal.removeEventListener("abort", onAbort);
					}
					const result = await this.callbacks.runConsult(job.request);
					this.#settle(job, { value: result });
				} catch (error) {
					this.#settle(job, { error });
				} finally {
					removeAbort?.();
				}
			}
		} finally {
			this.#busy = false;
			if (!this.#disposed && this.#jobs.length > 0) void this.#drain();
		}
	}

	#settle(
		job: AdvisorConsultJob,
		outcome: { readonly value: { readonly reply: string } } | { readonly error: unknown },
	): void {
		if (job.settled) return;
		job.settled = true;
		job.removeQueuedAbort?.();
		if (this.#inFlightConsult === job) this.#inFlightConsult = undefined;
		if ("error" in outcome) {
			const toolCallId = job.request.toolCallId;
			if (toolCallId) this.callbacks.unmarkToolCallSeen(toolCallId);
			job.reject(outcome.error);
			return;
		}
		job.resolve(outcome.value);
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
