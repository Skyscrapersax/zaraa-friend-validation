import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const SECRET_PATTERNS = [
	/\bsk-[A-Za-z0-9_-]{6,}\b/g,
	/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
	/\b(api[_-]?key|token|secret|password)=([^,\s]+)/gi,
];

function sanitizeText(value) {
	let text = String(value ?? "");
	text = text.replace(SECRET_PATTERNS[0], "[REDACTED]");
	text = text.replace(SECRET_PATTERNS[1], "[REDACTED]");
	text = text.replace(SECRET_PATTERNS[2], "$1=[REDACTED]");
	return text.slice(0, 500);
}

function sanitizeValue(value) {
	if (value == null) return value;
	if (typeof value === "string") return sanitizeText(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeValue);
	if (typeof value === "object") {
		const out = {};
		for (const [key, nested] of Object.entries(value).slice(0, 30)) {
			out[sanitizeText(key)] = sanitizeValue(nested);
		}
		return out;
	}
	return sanitizeText(value);
}

export function normalizeRestartIntentEvent(event = {}, now = new Date()) {
	const timestamp =
		typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp))
			? event.timestamp
			: now.toISOString();
	return {
		...sanitizeValue(event),
		timestamp,
		pid: Number.isFinite(Number(event.pid)) ? Number(event.pid) : process.pid,
		source: sanitizeText(event.source || "unknown"),
		reason: sanitizeText(event.reason || event.signal || "restart"),
	};
}

export function writeRestartIntentEvent({ path, event }) {
	if (!path) return null;
	try {
		const normalized = normalizeRestartIntentEvent(event);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		appendFileSync(path, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
		return normalized;
	} catch {
		return null;
	}
}

function numberOrZero(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

export function writeDaemonExitIntent({
	path,
	now = new Date(),
	pid,
	source,
	reason,
	signal,
	queue,
	activeTasks,
	extra,
} = {}) {
	const normalizedQueue = queue
		? {
				running: numberOrZero(queue.running),
				pending: numberOrZero(queue.pending),
				blocked: numberOrZero(queue.blocked),
			}
		: undefined;
	const computedActiveTasks =
		activeTasks ?? (normalizedQueue ? normalizedQueue.running + normalizedQueue.pending : undefined);
	return writeRestartIntentEvent({
		path,
		event: {
			...(extra && typeof extra === "object" ? extra : {}),
			timestamp: now.toISOString(),
			pid,
			source,
			reason,
			signal,
			...(normalizedQueue ? { queue: normalizedQueue } : {}),
			...(computedActiveTasks == null ? {} : { activeTasks: computedActiveTasks }),
		},
	});
}

export function writeDaemonStartIntent({
	path,
	now = new Date(),
	pid,
	ppid,
	source = "zaraa-daemon.startup",
	reason = "daemon process started",
	serviceLabel,
	extra,
} = {}) {
	return writeRestartIntentEvent({
		path,
		event: {
			...(extra && typeof extra === "object" ? extra : {}),
			timestamp: now.toISOString(),
			pid,
			...(Number.isFinite(Number(ppid)) ? { ppid: Number(ppid) } : {}),
			source,
			reason,
			...(serviceLabel ? { serviceLabel } : {}),
		},
	});
}

export function readLatestRestartIntent(path, options = {}) {
	if (!path || !existsSync(path)) return null;
	const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
	const windowMs = Number.isFinite(Number(options.windowMs)) ? Number(options.windowMs) : 10 * 60 * 1000;
	const serviceLabel = options.serviceLabel ? String(options.serviceLabel) : "";
	const ignoredSources = new Set(
		(Array.isArray(options.ignoreSources) ? options.ignoreSources : [])
			.map((source) => String(source)),
	);
	const lines = readFileSync(path, "utf8").trim().split(/\n/).filter(Boolean).slice(-200).reverse();
	for (const line of lines) {
		try {
			const event = JSON.parse(line);
			const timestampMs = Date.parse(event?.timestamp);
			if (!Number.isFinite(timestampMs)) continue;
			if (Number.isFinite(nowMs) && nowMs - timestampMs > windowMs) continue;
			if (ignoredSources.has(String(event?.source ?? ""))) continue;
			if (serviceLabel && String(event?.serviceLabel ?? "") !== serviceLabel) continue;
			return sanitizeValue(event);
		} catch {
			// Ignore corrupt historical lines.
		}
	}
	return null;
}
