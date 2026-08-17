#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
	MANIFEST_PATH,
	ensureFreshOvernightManifest,
	getTaskPrompt,
	loadApiKey,
	selectManifestTasks,
} from "./overnight-operator-lib.mjs";

const BASE = process.env.ZARAA_GATEWAY_BASE ?? "http://localhost:3927";
const DEFAULT_ROUTE_MODELS = {
	guarded: "gpt-5.5-low",
	trusted: "gpt-5.5",
	sandbox: "gpt-5.5-low",
};

function parseArgs(argv) {
	const options = {
		task: null,
		match: null,
		limit: null,
		preview: "brief",
		voice: "operator",
		routeModel: null,
		dryRun: false,
		list: false,
		delayMs: 200,
	};

	for (const arg of argv) {
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--list") options.list = true;
		else if (arg.startsWith("--task=")) options.task = arg.split("=")[1] ?? "";
		else if (arg.startsWith("--match=")) options.match = arg.split("=")[1] ?? "";
		else if (arg.startsWith("--limit=")) options.limit = Number.parseInt(arg.split("=")[1] ?? "", 10);
		else if (arg.startsWith("--preview=")) options.preview = (arg.split("=")[1] ?? "brief").trim().toLowerCase();
		else if (arg.startsWith("--voice=")) options.voice = (arg.split("=")[1] ?? "operator").trim().toLowerCase();
		else if (arg.startsWith("--route-model=")) options.routeModel = (arg.split("=")[1] ?? "").trim();
		else if (arg.startsWith("--delay-ms=")) options.delayMs = Number.parseInt(arg.split("=")[1] ?? "", 10);
	}

	return options;
}

async function ensureGatewayHealthy() {
	const response = await fetch(`${BASE}/health`);
	if (!response.ok) {
		throw new Error(`Gateway health check failed with status ${response.status}`);
	}
}

function getRouteModel(task, options) {
	if (options.routeModel) return options.routeModel;
	return DEFAULT_ROUTE_MODELS[task.zone] ?? DEFAULT_ROUTE_MODELS.guarded;
}

async function submitTask(task, apiKey, index, total, voice, options) {
	const routeModel = getRouteModel(task, options);
	const response = await fetch(`${BASE}/api/dispatch`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Api-Key": apiKey,
		},
		body: JSON.stringify({
			prompt: getTaskPrompt(task, voice),
			priority: task.priority,
			zone: task.zone,
			...(routeModel ? { routing: { model: routeModel } } : {}),
			notifications: { mode: "silent" },
			goalRef: `overnight-pack-${task.id}`,
			whyNow:
				"operator queued an overnight supervision block so Zaraa can keep learning, self-healing, and preparing a strong morning handoff",
			doneDefinition:
				"deliver the requested overnight artifact with grounded evidence, the clearest blocker or risk, and the best first morning move",
			source: "operator-overnight-pack",
		}),
	});

	let payload = null;
	try {
		payload = await response.json();
	} catch {
		payload = null;
	}

	if (!response.ok) {
		throw new Error(payload?.error ?? payload?.message ?? `HTTP ${response.status}`);
	}

	const dispatchId = payload?.id ?? payload?.taskId ?? payload?.data?.id ?? "unknown";
	console.log(
		`[${String(index + 1).padStart(2, "0")}/${String(total).padStart(2, "0")}] OK ${dispatchId} :: ${task.id} :: ${task.title}`,
	);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const freshManifest = ensureFreshOvernightManifest();
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	const tasks = selectManifestTasks(manifest, options);

	if (options.list) {
		for (const task of tasks) {
			console.log(`${task.id} :: ${task.title}`);
			console.log(`  selected because: ${task.selectionReason}`);
		}
		return;
	}

	if (tasks.length === 0) {
		throw new Error("No overnight tasks matched the requested selector.");
	}

	console.log(`Selected ${tasks.length} overnight task(s)`);
	console.log(`Voice: ${options.voice}`);
	console.log(
		`Routing: ${options.routeModel ? options.routeModel : "zone-default (gpt-5.5 / gpt-5.5-low)"}`,
	);
	console.log(`Adaptive queue built at ${freshManifest.metadata.generatedAt}`);

	if (options.dryRun) {
		console.log("");
		for (const task of tasks) {
			if (options.preview === "full") {
				console.log(`### ${task.id} — ${task.title}`);
				console.log(`Selected because: ${task.selectionReason}`);
				console.log(getTaskPrompt(task, options.voice).trimEnd());
				console.log("");
			} else {
				console.log(`${task.id} :: ${task.title}`);
				console.log(`  ${task.operatorBrief}`);
				console.log(`  selected because: ${task.selectionReason}`);
			}
		}
		return;
	}

	const apiKey = loadApiKey();
	if (!apiKey) {
		throw new Error("Missing API key. Set ZARAA_API_KEY or gateway.auth.apiKey in ~/.zaraa/zaraa.config.json");
	}

	await ensureGatewayHealthy();
	console.log(`Submitting ${tasks.length} overnight operator task(s) to ${BASE}`);

	for (let index = 0; index < tasks.length; index++) {
		await submitTask(tasks[index], apiKey, index, tasks.length, options.voice, options);
		if (options.delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, options.delayMs));
		}
	}

	console.log("Submission complete.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
