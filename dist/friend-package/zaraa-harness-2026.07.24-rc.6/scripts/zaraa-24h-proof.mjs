#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	attachRuntimeConfigRevision,
	bindRuntimeIdentity,
	createRuntimeIdentity,
	runtimeIdentityBreakReasons,
} from "./lib/runtime-proof-identity.mjs";

function resolveRuntimeHomeDir() {
	const raw = process.env.ZARAA_HOME_DIR;
	if (raw === undefined) return homedir();
	const value = raw.trim();
	if (!value || !isAbsolute(value)) {
		throw new Error("ZARAA_HOME_DIR must be a non-empty absolute path");
	}
	const resolved = resolve(value);
	if (dirname(resolved) === resolved) throw new Error("ZARAA_HOME_DIR cannot be a filesystem root");
	return resolved;
}

const RUNTIME_HOME_DIR = resolveRuntimeHomeDir();
const CONFIG_PATH = join(RUNTIME_HOME_DIR, ".zaraa", "zaraa.config.json");
const DATA_DIR = join(RUNTIME_HOME_DIR, ".zaraa", "data");
const STATE_DIR = join(RUNTIME_HOME_DIR, ".zaraa", "state");
const DEFAULT_START_PATH = join(STATE_DIR, "zaraa-24h-proof-start.json");
const OPERATOR_START_PATH = join(STATE_DIR, "zaraa-24h-proof-operator-start.json");
const DEFAULT_BASE = "http://127.0.0.1:3927";
export const FRIEND_BETA_PROOF_SUMMARY_PATTERN =
	/^zaraa-24h-proof-\d{8}T\d{6}Z\.summary\.json$/;

export function proofSummaryFileName(id, profile = "friend-beta") {
	return profile === "operator"
		? `zaraa-24h-proof-operator-${id}.summary.json`
		: `zaraa-24h-proof-${id}.summary.json`;
}

function proofJsonlFileName(id, profile = "friend-beta") {
	return profile === "operator"
		? `zaraa-24h-proof-operator-${id}.jsonl`
		: `zaraa-24h-proof-${id}.jsonl`;
}

function startPathForProfile(profile = "friend-beta") {
	return profile === "operator" ? OPERATOR_START_PATH : DEFAULT_START_PATH;
}

function resolveProofProfile(raw = "friend-beta") {
	const profile = String(raw ?? "friend-beta").trim() || "friend-beta";
	if (profile !== "friend-beta" && profile !== "operator") {
		throw new Error(`invalid --profile: ${profile} (expected friend-beta or operator)`);
	}
	return profile;
}

function arg(name, fallback = null) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function hasArg(name) {
	return process.argv.includes(name);
}

function runId(startIso) {
	return startIso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function readConfig() {
	if (!existsSync(CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return {};
	}
}

function defaultStartIso(startPath = DEFAULT_START_PATH) {
	if (process.env.ZARAA_24H_START) return process.env.ZARAA_24H_START;
	if (existsSync(startPath)) {
		try {
			const saved = JSON.parse(readFileSync(startPath, "utf8"));
			if (typeof saved.start === "string") return saved.start;
		} catch {}
	}
	const start = new Date().toISOString();
	saveStartIso(start, startPath);
	return start;
}

function saveStartIso(start, startPath = DEFAULT_START_PATH) {
	mkdirSync(dirname(startPath), { recursive: true });
	writeFileSync(startPath, JSON.stringify({ start }, null, 2) + "\n");
	return start;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(result) {
	const retryAfter = Number(result.retryAfter ?? result.body?.retryAfter ?? 1);
	return Math.max(
		1_000,
		Math.min(30_000, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 1_000),
	);
}

async function getJson(path, apiKey, baseUrl) {
	try {
		const res = await fetch(`${baseUrl}${path}`, {
			headers: apiKey ? { "X-Api-Key": apiKey } : {},
		});
		const body = await res.json().catch(() => ({}));
		return {
			status: res.status,
			body,
			retryAfter: res.headers.get("Retry-After") ?? body?.retryAfter ?? null,
		};
	} catch (err) {
		return { status: 0, body: { error: err instanceof Error ? err.message : String(err) } };
	}
}

async function getJsonWithRetry(path, apiKey, baseUrl) {
	let result = await getJson(path, apiKey, baseUrl);
	for (let attempt = 0; (result.status === 429 || result.status === 0) && attempt < 3; attempt++) {
		await sleep(retryDelayMs(result));
		result = await getJson(path, apiKey, baseUrl);
	}
	return result;
}

function statusLabel(name, probe) {
	if (probe.status === 429) return `${name} probe rate limited`;
	return null;
}

function isAbsentConfig(value) {
	return value === undefined || value === null;
}

function friendBetaFlagReason(value, { expect, absent, mismatch }) {
	if (isAbsentConfig(value)) return absent;
	if (value !== expect) return mismatch;
	return null;
}

function isIndeterminateReason(reason) {
	return reason.endsWith(" (unknown)") || reason.endsWith("probe rate limited");
}

export function evaluate(probes, { profile = "friend-beta" } = {}) {
	const operator = resolveProofProfile(profile) === "operator";
	const reasons = [];
	if (probes.health.status !== 200 || probes.health.body?.status !== "ok")
		reasons.push("gateway health not ok");
	const configLimit = statusLabel("config", probes.config);
	if (configLimit) reasons.push(configLimit);
	else if (probes.config.status !== 200) reasons.push("runtime config unreachable");
	else {
		const config = probes.config.body;
		const providers = Array.isArray(config?.providers)
			? config.providers.filter((provider) => provider?.enabled !== false)
			: [];
		if (providers.length === 0) reasons.push("no enabled provider configured");
		if (
			providers.some((provider) => provider?.type === "ollama") &&
			probes.health.body?.ollama !== "healthy"
		) {
			reasons.push("ollama not healthy");
		}
		if (!operator) {
			const trusted = friendBetaFlagReason(config?.gateway?.trusted, {
				expect: true,
				absent: "gateway trusted mode not configured (unknown)",
				mismatch: "gateway trusted mode not enabled",
			});
			if (trusted) reasons.push(trusted);
		}
		if (config?.autonomy?.mode !== "handsOff") reasons.push("autonomy config mode not handsOff");
		if (config?.trading?.paperMode !== true) reasons.push("trading paper mode not enabled");
		if (config?.trading?.autoExecuteLive !== false)
			reasons.push("trading live execution not disabled");
		if (!operator) {
			const background = friendBetaFlagReason(config?.trading?.backgroundAutomation, {
				expect: false,
				absent: "trading background automation not configured (unknown)",
				mismatch: "trading background automation not disabled",
			});
			if (background) reasons.push(background);
			const predictionPaper = friendBetaFlagReason(config?.predictions?.paperMode, {
				expect: true,
				absent: "prediction paper mode not configured (unknown)",
				mismatch: "prediction paper mode not enabled",
			});
			if (predictionPaper) reasons.push(predictionPaper);
			const predictionLive = friendBetaFlagReason(config?.predictions?.autoExecuteLive, {
				expect: false,
				absent: "prediction live execution not configured (unknown)",
				mismatch: "prediction live execution not disabled",
			});
			if (predictionLive) reasons.push(predictionLive);
		}
		if (!operator && config?.scheduler?.overnight?.enabled !== false)
			reasons.push("overnight scheduler not disabled");
		if (
			!operator &&
			(!Array.isArray(config?.scheduler?.tasks) ||
				config.scheduler.tasks.some((task) => task?.enabled !== false))
		) {
			reasons.push("scheduled task not disabled");
		}
		if (!operator && config?.voice?.enabled !== false) reasons.push("voice not disabled");
	}
	const zoneLimit = statusLabel("zone", probes.zone);
	if (zoneLimit) reasons.push(zoneLimit);
	else if (probes.zone.status !== 200) reasons.push("gateway zone unreachable");
	else if (!operator && probes.zone.body?.zone !== "guarded")
		reasons.push("gateway zone not guarded");
	const generationLimit = statusLabel("generation", probes.generation);
	if (generationLimit) reasons.push(generationLimit);
	else if (probes.generation.status !== 200) reasons.push("generation paused/unreachable");
	else if (!operator && probes.generation.body?.paused !== false)
		reasons.push("generation paused/unreachable");
	if (probes.generation.body?.operatorHold === true) reasons.push("operator hold active");
	const executionLimit = statusLabel("execution", probes.execution);
	if (executionLimit) reasons.push(executionLimit);
	else if (probes.execution.status !== 200) reasons.push("execution paused/unreachable");
	else if (!operator && probes.execution.body?.paused !== false)
		reasons.push("execution paused/unreachable");
	else if (
		!Number.isInteger(probes.execution.body?.activeCount) ||
		probes.execution.body.activeCount < 0
	)
		reasons.push("execution active count invalid");
	const breakerLimit = statusLabel("circuit breaker", probes.breaker);
	if (breakerLimit) reasons.push(breakerLimit);
	else if (probes.breaker.status !== 200) reasons.push("circuit breaker unreachable");
	else if (probes.breaker.body?.tripped === true) reasons.push("circuit breaker tripped");
	const autonomyLimit = statusLabel("autonomy", probes.autonomy);
	if (autonomyLimit) reasons.push(autonomyLimit);
	else if (probes.autonomy.status !== 200) reasons.push("autonomy paused/unreachable");
	else if (!operator && probes.autonomy.body?.paused === true)
		reasons.push("autonomy paused/unreachable");
	if (probes.autonomy.body?.mode && probes.autonomy.body.mode !== "handsOff")
		reasons.push(`mode=${probes.autonomy.body.mode}`);
	const tradingLimit = statusLabel("trading", probes.trading);
	if (tradingLimit) reasons.push(tradingLimit);
	else if (probes.trading.status !== 200) reasons.push("trading safety unreachable");
	else if (
		probes.trading.body?.systems?.killSwitch?.active === true ||
		probes.trading.body?.killSwitch === true
	)
		reasons.push("trading kill switch active");
	if (
		probes.trading.status === 200 &&
		probes.trading.body?.systems?.circuitBreaker?.tripped === true
	)
		reasons.push("trading circuit breaker tripped");
	const rateLimitedOnly =
		reasons.length > 0 && reasons.every((reason) => reason.endsWith("probe rate limited"));
	const indeterminateOnly =
		reasons.length > 0 && reasons.every((reason) => isIndeterminateReason(reason));
	return {
		ok: reasons.length === 0 ? true : rateLimitedOnly || indeterminateOnly ? null : false,
		reasons,
	};
}

function compactProbe(probe) {
	return {
		status: probe.status,
		retryAfter: probe.retryAfter ?? probe.body?.retryAfter ?? null,
		code: probe.body?.code ?? null,
		error: probe.body?.error ?? null,
	};
}

function readLaunchdService(label) {
	try {
		const uid = process.getuid?.();
		const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
			encoding: "utf8",
			timeout: 3_000,
		});
		const firstState = out.match(/^\s*state = ([^\n]+)/m)?.[1]?.trim() ?? null;
		return {
			label,
			state: firstState,
			pid: Number(out.match(/^\s*pid = (\d+)/m)?.[1] ?? NaN),
			runs: Number(out.match(/^\s*runs = (\d+)/m)?.[1] ?? NaN),
			lastExitCode: out.match(/^\s*last exit code = ([^\n]+)/m)?.[1]?.trim() ?? null,
		};
	} catch (err) {
		return {
			label,
			state: null,
			pid: null,
			runs: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function gatewayPort(baseUrl) {
	const url = new URL(baseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`unsupported gateway protocol: ${url.protocol}`);
	}
	return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function readExplicitProcess(pid, baseUrl) {
	try {
		process.kill(pid, 0);
	} catch (err) {
		return {
			label: "explicit-pid",
			state: null,
			pid,
			runs: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	let port;
	try {
		port = gatewayPort(baseUrl);
	} catch (err) {
		return {
			label: "explicit-pid",
			state: "running",
			pid,
			runs: 1,
			lastExitCode: null,
			gatewayBound: false,
			gatewayError: err instanceof Error ? err.message : String(err),
		};
	}

	try {
		const out = execFileSync(
			"lsof",
			["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
			{ encoding: "utf8", timeout: 3_000 },
		);
		const listenerPids = out
			.split("\n")
			.map((value) => Number(value.trim()))
			.filter(Number.isFinite);
		return {
			label: "explicit-pid",
			state: "running",
			pid,
			runs: 1,
			lastExitCode: null,
			gatewayPort: port,
			gatewayBound: listenerPids.includes(pid),
		};
	} catch (err) {
		return {
			label: "explicit-pid",
			state: "running",
			pid,
			runs: 1,
			lastExitCode: null,
			gatewayPort: port,
			gatewayBound: false,
			gatewayError: err instanceof Error ? err.message : String(err),
		};
	}
}

async function sample({ apiKey, baseUrl, daemonPid, profile = "friend-beta" }) {
	const paths = [
		["health", "/api/health"],
		["config", "/api/config"],
		["zone", "/api/zone"],
		["generation", "/api/tasks/generation"],
		["execution", "/api/tasks/execution"],
		["breaker", "/api/circuit-breaker"],
		["autonomy", "/api/autonomy/status"],
		["trading", "/api/trading/safety-health"],
		["alerts", "/api/alerts?limit=1"],
	];
	const probes = {};
	for (const [name, path] of paths) {
		probes[name] = await getJsonWithRetry(path, apiKey, baseUrl);
		await sleep(250);
	}
	const { health, config, zone, generation, execution, breaker, autonomy, trading, alerts } =
		probes;
	const daemon = daemonPid
		? readExplicitProcess(daemonPid, baseUrl)
		: readLaunchdService("com.zaraa.daemon");
	const verdict = evaluate(probes, { profile });
	const reasons = [...verdict.reasons];
	if (daemon.state !== "running" || !Number.isFinite(daemon.pid)) {
		reasons.push(daemonPid ? "explicit daemon process not running" : "daemon launchd not running");
	}
	if (daemonPid && daemon.gatewayBound !== true)
		reasons.push("explicit daemon does not own gateway listener");
	const ts = new Date().toISOString();
	let runtimeIdentity = null;
	try {
		runtimeIdentity = attachRuntimeConfigRevision(
			bindRuntimeIdentity(createRuntimeIdentity(), {
				observedAt: ts,
				uptimeSeconds: health.body?.uptime,
			}),
			CONFIG_PATH,
		);
	} catch (error) {
		reasons.push(
			`runtime identity unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return {
		ts,
		profile,
		ok: verdict.ok === false || reasons.length > verdict.reasons.length ? false : verdict.ok,
		reasons,
		health: health.body?.status ?? null,
		ollama: health.body?.ollama ?? null,
		generationPaused: generation.body?.paused ?? null,
		operatorHold: generation.body?.operatorHold ?? null,
		executionPaused: execution.body?.paused ?? null,
		activeCount: execution.body?.activeCount ?? null,
		circuitTripped: breaker.body?.tripped ?? null,
		zone: zone.body?.zone ?? null,
		autonomyPaused: autonomy.body?.paused ?? null,
		mode: autonomy.body?.mode ?? null,
		tradingOverall: trading.body?.overall ?? null,
		killSwitch: trading.body?.systems?.killSwitch?.active ?? trading.body?.killSwitch ?? null,
		latestAlert: Array.isArray(alerts.body?.alerts) ? (alerts.body.alerts[0]?.title ?? null) : null,
		configSafety: {
			gatewayTrusted: config.body?.gateway?.trusted ?? null,
			tradingPaperMode: config.body?.trading?.paperMode ?? null,
			tradingAutoExecuteLive: config.body?.trading?.autoExecuteLive ?? null,
			tradingBackgroundAutomation: config.body?.trading?.backgroundAutomation ?? null,
			predictionsPaperMode: config.body?.predictions?.paperMode ?? null,
			predictionsAutoExecuteLive: config.body?.predictions?.autoExecuteLive ?? null,
		},
		probes: Object.fromEntries(
			Object.entries(probes).map(([name, probe]) => [name, compactProbe(probe)]),
		),
		daemon,
		runtimeIdentity,
	};
}

function loadRows(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function summarize(rows, startMs, endMs, nowMs = Date.now()) {
	const inWindow = rows.filter((r) => {
		const t = Date.parse(r.ts);
		return Number.isFinite(t) && t >= startMs && t <= Math.max(nowMs, endMs);
	});
	const bad = inWindow.filter((r) => r.ok === false);
	const indeterminate = inWindow.filter((r) => r.ok === null);
	const times = inWindow
		.map((r) => Date.parse(r.ts))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const goodTimes = inWindow
		.filter((r) => r.ok === true)
		.map((r) => Date.parse(r.ts))
		.filter(Number.isFinite)
		.sort((a, b) => a - b);
	const daemonBaseline =
		inWindow.find((r) => r.ok === true && Number.isFinite(r.daemon?.runs))?.daemon ?? null;
	const runtimeIdentity =
		inWindow.find((r) => r.ok === true && r.runtimeIdentity?.sha256)?.runtimeIdentity ?? null;
	const continuityBreaks = inWindow
		.filter((r) => r.ok === true)
		.flatMap((r) => {
			const reasons = [];
			if (
				daemonBaseline &&
				Number.isFinite(r.daemon?.runs) &&
				r.daemon.runs !== daemonBaseline.runs
			) {
				reasons.push("daemon restarted");
			}
			reasons.push(...runtimeIdentityBreakReasons(r.runtimeIdentity, runtimeIdentity));
			return reasons.length > 0
				? [{ ...r, ok: false, reasons: [...(r.reasons ?? []), ...reasons] }]
				: [];
		});
	const allBad = [...bad, ...continuityBreaks];
	let maxGapMs = 0;
	for (let i = 1; i < goodTimes.length; i++)
		maxGapMs = Math.max(maxGapMs, goodTimes[i] - goodTimes[i - 1]);
	const complete =
		nowMs >= endMs &&
		goodTimes[0] <= startMs + 6 * 60_000 &&
		goodTimes.at(-1) >= endMs &&
		maxGapMs <= 10 * 60_000 &&
		allBad.length === 0;
	return {
		start: new Date(startMs).toISOString(),
		end: new Date(endMs).toISOString(),
		now: new Date(nowMs).toISOString(),
		complete,
		sampleCount: inWindow.length,
		goodCount: goodTimes.length,
		indeterminateCount: indeterminate.length,
		badCount: allBad.length,
		continuityBreakCount: continuityBreaks.length,
		maxGapMin: Math.round(maxGapMs / 60_000),
		firstSample: times[0] ? new Date(times[0]).toISOString() : null,
		lastSample: times.at(-1) ? new Date(times.at(-1)).toISOString() : null,
		firstGoodSample: goodTimes[0] ? new Date(goodTimes[0]).toISOString() : null,
		lastGoodSample: goodTimes.at(-1) ? new Date(goodTimes.at(-1)).toISOString() : null,
		daemonBaseline,
		runtimeIdentity,
		lastBad: allBad.at(-1) ?? null,
	};
}

function selfTest() {
	const goodProbe = {
		health: { status: 200, body: { status: "ok", ollama: "healthy" } },
		config: {
			status: 200,
			body: {
				providers: [{ name: "local", type: "ollama", enabled: true }],
				gateway: { trusted: true },
				autonomy: { mode: "handsOff" },
				trading: { paperMode: true, autoExecuteLive: false, backgroundAutomation: false },
				predictions: { paperMode: true, autoExecuteLive: false },
				scheduler: { tasks: [{ id: "daily", enabled: false }], overnight: { enabled: false } },
				voice: { enabled: false },
			},
		},
		zone: { status: 200, body: { zone: "guarded" } },
		generation: { status: 200, body: { paused: false, operatorHold: false } },
		execution: { status: 200, body: { paused: false, activeCount: 0 } },
		breaker: { status: 200, body: { tripped: false } },
		autonomy: { status: 200, body: { paused: false, mode: "handsOff" } },
		trading: { status: 200, body: { killSwitch: false } },
	};
	assert.equal(evaluate(goodProbe).ok, true);
	assert.equal(
		evaluate({ ...goodProbe, breaker: { status: 200, body: { tripped: true } } }).ok,
		false,
	);
	assert.equal(
		evaluate({ ...goodProbe, zone: { status: 200, body: { zone: "trusted" } } }).ok,
		false,
	);
	assert.equal(
		evaluate({ ...goodProbe, execution: { status: 200, body: { paused: false, activeCount: 1 } } })
			.ok,
		true,
	);
	for (const activeCount of [-1, 1.5, "1", undefined]) {
		assert.equal(
			evaluate({
				...goodProbe,
				execution: { status: 200, body: { paused: false, activeCount } },
			}).ok,
			false,
		);
	}
	assert.equal(
		evaluate({ ...goodProbe, execution: { status: 200, body: { paused: true, activeCount: 1 } } })
			.ok,
		false,
	);
	assert.equal(
		evaluate({ ...goodProbe, health: { status: 200, body: { status: "ok", ollama: "down" } } }).ok,
		false,
	);
	assert.equal(
		evaluate({
			...goodProbe,
			config: {
				...goodProbe.config,
				body: {
					...goodProbe.config.body,
					trading: { ...goodProbe.config.body.trading, paperMode: false },
				},
			},
		}).ok,
		false,
	);
	const limitedVerdict = evaluate({
		...goodProbe,
		generation: { status: 429, body: { retryAfter: 1 } },
	});
	assert.equal(limitedVerdict.ok, null);
	assert.deepEqual(limitedVerdict.reasons, ["generation probe rate limited"]);
	const unknownPredictions = evaluate({
		...goodProbe,
		config: {
			...goodProbe.config,
			body: { ...goodProbe.config.body, predictions: undefined },
		},
	});
	assert.equal(unknownPredictions.ok, null);
	assert.ok(unknownPredictions.reasons.every((reason) => reason.endsWith(" (unknown)")));
	assert.ok(unknownPredictions.reasons.includes("prediction paper mode not configured (unknown)"));
	assert.ok(
		unknownPredictions.reasons.includes("prediction live execution not configured (unknown)"),
	);
	const explicitUnsafePredictions = evaluate({
		...goodProbe,
		config: {
			...goodProbe.config,
			body: {
				...goodProbe.config.body,
				predictions: { paperMode: false, autoExecuteLive: false },
			},
		},
	});
	assert.equal(explicitUnsafePredictions.ok, false);
	assert.ok(explicitUnsafePredictions.reasons.includes("prediction paper mode not enabled"));
	assert.ok(
		!explicitUnsafePredictions.reasons.some((reason) => reason.endsWith(" (unknown)")),
	);
	assert.equal(retryDelayMs({ status: 429, body: { retryAfter: 2 } }), 2_000);
	assert.equal(retryDelayMs({ status: 0, body: {} }), 1_000);
	assert.equal(gatewayPort("http://127.0.0.1:3927"), 3927);
	assert.equal(gatewayPort("https://example.com"), 443);
	assert.equal(readExplicitProcess(process.pid, DEFAULT_BASE).state, "running");
	assert.notEqual(readExplicitProcess(2_147_483_647, DEFAULT_BASE).state, "running");
	const start = Date.parse("2026-07-08T00:00:00.000Z");
	const runtimeIdentity = {
		schemaVersion: 1,
		sha256: "abc123",
		platform: process.platform,
		architecture: process.arch,
		nodeAbi: process.versions.modules,
		fileCount: 3,
		newestMtime: "2026-07-07T23:59:57.000Z",
		daemonStartedAt: "2026-07-07T23:59:58.000Z",
		configRevision: {
			revision: "10:1",
			path: CONFIG_PATH,
			size: 10,
			mtime: "2026-07-07T23:59:57.000Z",
		},
	};
	const rows = [
		{ ts: "2026-07-08T00:00:00.000Z", ok: true, runtimeIdentity },
		{ ts: "2026-07-08T00:05:00.000Z", ok: null },
		{ ts: "2026-07-08T00:10:00.000Z", ok: true, runtimeIdentity },
	];
	assert.equal(summarize(rows, start, start + 10 * 60_000, start + 10 * 60_000).complete, true);
	const restartedRows = [
		{ ts: "2026-07-08T00:00:00.000Z", ok: true, daemon: { runs: 1, pid: 100 }, runtimeIdentity },
		{ ts: "2026-07-08T00:05:00.000Z", ok: true, daemon: { runs: 2, pid: 200 }, runtimeIdentity },
	];
	assert.equal(summarize(restartedRows, start, start + 5 * 60_000, start + 5 * 60_000).badCount, 1);
	const staleRuntime = { ...runtimeIdentity, newestMtime: "2026-07-08T00:00:10.000Z" };
	assert.equal(
		summarize([{ ...rows[0], runtimeIdentity: staleRuntime }], start, start, start).badCount,
		1,
	);
	const changedConfig = {
		...runtimeIdentity,
		configRevision: { ...runtimeIdentity.configRevision, revision: "11:2" },
	};
	assert.equal(
		summarize(
			[rows[0], { ...rows[2], runtimeIdentity: changedConfig }],
			start,
			start + 10 * 60_000,
			start + 10 * 60_000,
		).badCount,
		1,
	);
	assert.equal(summarize([{ ...rows[0], runtimeIdentity: null }], start, start, start).badCount, 1);
	assert.equal(summarize([{ ts: rows[0].ts, ok: false }], start, start, start).complete, false);
	console.log("self-test OK");
}

async function main() {
	if (hasArg("--self-test")) return selfTest();
	const profile = resolveProofProfile(arg("--profile", process.env.ZARAA_24H_PROFILE ?? "friend-beta"));
	const startPath = startPathForProfile(profile);
	const requestedStart = arg("--start");
	const startIso = hasArg("--restart-window")
		? saveStartIso(requestedStart ?? new Date().toISOString(), startPath)
		: (requestedStart ?? defaultStartIso(startPath));
	const startMs = Date.parse(startIso);
	if (!Number.isFinite(startMs)) throw new Error(`invalid --start: ${startIso}`);
	const durationHours = Number(
		arg("--duration-hours", process.env.ZARAA_24H_DURATION_HOURS ?? "24"),
	);
	const endMs = startMs + durationHours * 60 * 60 * 1000;
	const id = runId(new Date(startMs).toISOString());
	const out = arg(
		"--out",
		process.env.ZARAA_24H_OUT ?? join(DATA_DIR, proofJsonlFileName(id, profile)),
	);
	const summaryPath = arg(
		"--summary",
		process.env.ZARAA_24H_SUMMARY ?? join(DATA_DIR, proofSummaryFileName(id, profile)),
	);
	const cfg = readConfig();
	const apiKey = cfg?.gateway?.auth?.apiKey ?? cfg?.apiKey ?? null;
	const baseUrl = process.env.ZARAA_GATEWAY_BASE || DEFAULT_BASE;
	const print = hasArg("--print");
	const watch = hasArg("--watch");
	const daemonPidRaw = arg("--daemon-pid", process.env.ZARAA_24H_DAEMON_PID ?? "");
	const daemonPid = daemonPidRaw ? Number(daemonPidRaw) : null;
	if (daemonPidRaw && (!Number.isInteger(daemonPid) || daemonPid <= 0)) {
		throw new Error(`invalid --daemon-pid: ${daemonPidRaw}`);
	}
	const intervalMinutes = Number(
		arg("--interval-minutes", process.env.ZARAA_24H_INTERVAL_MINUTES ?? "5"),
	);
	const intervalMs = Math.max(
		60_000,
		Math.min(15 * 60_000, Number.isFinite(intervalMinutes) ? intervalMinutes * 60_000 : 5 * 60_000),
	);

	for (;;) {
		const row = await sample({ apiKey, baseUrl, daemonPid, profile });
		mkdirSync(dirname(out), { recursive: true });
		appendFileSync(out, JSON.stringify(row) + "\n");
		const summary = { profile, ...summarize(loadRows(out), startMs, endMs) };
		mkdirSync(dirname(summaryPath), { recursive: true });
		writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");
		if (print) console.log(JSON.stringify({ row, summary }, null, 2));
		if (!watch || summary.complete || summary.badCount > 0) break;
		await sleep(intervalMs);
	}
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) ===
		fileURLToPath(new URL(process.argv[1], pathToFileURL(process.cwd()).href))
) {
	main().catch((err) => {
		console.error(`zaraa-24h-proof: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	});
}
