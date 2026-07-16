export interface AdvisorConsultRequest {
	readonly message: string;
	readonly advisor?: string;
	readonly toolCallId?: string;
	readonly signal?: AbortSignal;
}

export interface AdvisorConsultResult {
	readonly reply: string;
	readonly advisor: string;
}

export type AdvisorConsult = (request: AdvisorConsultRequest) => Promise<AdvisorConsultResult>;
