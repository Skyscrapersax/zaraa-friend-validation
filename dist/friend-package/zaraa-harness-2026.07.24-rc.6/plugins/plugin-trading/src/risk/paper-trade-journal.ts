/**
 * Paper trade journal validation (harvest ZLW-T0319 family).
 * PaperMode only — never promotes to live execution.
 */

export type JournalSide = "long" | "short";
export type JournalStyle = "scalp" | "swing" | "position";
export type JournalExitReason = "stop" | "target" | "thesis_break" | "time" | "other";

export interface PaperTradeJournalEntry {
	/** ISO or free-text timestamp. */
	at?: string;
	symbol: string;
	side: JournalSide;
	style: JournalStyle;
	size: number;
	entryPrice: number;
	stopPrice?: number | null;
	stopPct?: number | null;
	takeProfit?: number | null;
	/** Required thesis break level. */
	invalidationLevel?: number | null;
	why?: string;
	thesisInvalidIf?: string;
	/** Must be true for a valid paper entry. */
	paperMode: boolean;
	// Exit (optional until closed)
	exitPrice?: number | null;
	exitReason?: JournalExitReason | null;
	realizedPnl?: number | null;
	learned?: string;
}

export interface PaperJournalValidation {
	ok: boolean;
	paperOnly: true;
	errors: string[];
	warnings: string[];
}

/**
 * Validate a paper journal entry for completeness + paperMode hard rule.
 * Never executes trades.
 */
export function validatePaperTradeJournal(
	entry: PaperTradeJournalEntry,
): PaperJournalValidation {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!entry.paperMode) {
		errors.push("paperMode must be true — live journal promotion refused");
	}
	if (!entry.symbol || !String(entry.symbol).trim()) {
		errors.push("symbol required");
	}
	if (entry.side !== "long" && entry.side !== "short") {
		errors.push("side must be long or short");
	}
	if (!["scalp", "swing", "position"].includes(entry.style)) {
		errors.push("style must be scalp | swing | position");
	}
	if (!(entry.size > 0) || !Number.isFinite(entry.size)) {
		errors.push("size must be a positive number");
	}
	if (!(entry.entryPrice > 0) || !Number.isFinite(entry.entryPrice)) {
		errors.push("entryPrice must be a positive number");
	}

	const hasStop =
		(entry.stopPrice != null && entry.stopPrice > 0) ||
		(entry.stopPct != null && entry.stopPct > 0);
	if (!hasStop) {
		errors.push("stop required (stopPrice or stopPct) before size-up");
	}

	if (entry.invalidationLevel == null || !(entry.invalidationLevel > 0)) {
		errors.push("invalidationLevel required before entry");
	}

	if (!entry.why || !String(entry.why).trim()) {
		warnings.push("why thesis empty — fill within session");
	}
	if (!entry.thesisInvalidIf || !String(entry.thesisInvalidIf).trim()) {
		warnings.push("thesisInvalidIf empty — write break condition");
	}

	if (entry.exitPrice != null) {
		if (!(entry.exitPrice > 0) || !Number.isFinite(entry.exitPrice)) {
			errors.push("exitPrice invalid");
		}
		if (!entry.exitReason) {
			warnings.push("exitReason missing on closed trade");
		}
	}

	return {
		ok: errors.length === 0,
		paperOnly: true,
		errors,
		warnings,
	};
}

/** Session checklist flags (operator UI / CLI). */
export function paperJournalSessionChecklist(entries: PaperTradeJournalEntry[]): {
	paperOnly: true;
	entryCount: number;
	allPaperMode: boolean;
	missingStop: number;
	missingInvalidation: number;
	closed: number;
} {
	let missingStop = 0;
	let missingInvalidation = 0;
	let closed = 0;
	let allPaperMode = true;
	for (const e of entries) {
		if (!e.paperMode) allPaperMode = false;
		const hasStop =
			(e.stopPrice != null && e.stopPrice > 0) ||
			(e.stopPct != null && e.stopPct > 0);
		if (!hasStop) missingStop += 1;
		if (e.invalidationLevel == null || !(e.invalidationLevel > 0)) {
			missingInvalidation += 1;
		}
		if (e.exitPrice != null && e.exitPrice > 0) closed += 1;
	}
	return {
		paperOnly: true,
		entryCount: entries.length,
		allPaperMode,
		missingStop,
		missingInvalidation,
		closed,
	};
}
