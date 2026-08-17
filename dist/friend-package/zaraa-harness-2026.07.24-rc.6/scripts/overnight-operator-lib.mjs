import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT = process.cwd();
export const OUTPUT_DIR = join(ROOT, "docs", "runbooks");
export const MANIFEST_PATH = join(OUTPUT_DIR, "zaraa-overnight-operator-pack.json");
export const MARKDOWN_PATH = join(OUTPUT_DIR, "zaraa-overnight-operator-pack.md");
const DEFAULT_OVERNIGHT_WINDOW = { startHour: 23, endHour: 7 };
const HISTORY_LOOKBACK_HOURS = 36;
const HISTORY_LIMIT = 400;
const DEFAULT_MIN_TASKS = 6;
const DEFAULT_MAX_TASKS = 8;

const THEME_PATTERNS = {
	trading: /\b(btc|eth|sol|portfolio|risk|trade_|drawdown|position|market regime)\b/i,
	testing: /\b(test|tests|vitest|jest|coverage|ci|github actions?|failing check|flake)\b/i,
	research: /\b(research|investigate|explore|benchmark|compare|spec)\b/i,
	docs: /\b(doc|docs|readme|runbook|guide|playbook|operator|prompt|procedure)\b/i,
	quality: /\b(truncated|truncate|planner fallback|cleanup burden|qa status|acceptance)\b/i,
};

const BLUEPRINTS = [
	{
		id: "ovn-001",
		title: "Overnight Market Regime Sweep",
		priority: "high",
		zone: "trusted",
		category: "market",
		sequence: 10,
		objective: "Build a clean overnight read on market state without drowning me in noise.",
		deliverable: "a concise regime update for BTC, ETH, and SOL with only meaningful shifts called out",
		score(snapshot) {
			const signal = snapshot.themeCounts.trading;
			if (signal === 0) return { score: 0, reason: "No recent trading or market signal detected." };
			return {
				score: 34 + Math.min(signal, 6) * 5,
				reason: `Recent work carried ${signal} trading or risk signals, so the night queue should begin with a fresh market read.`,
			};
		},
	},
	{
		id: "ovn-002",
		title: "Overnight Portfolio Risk Watch",
		priority: "high",
		zone: "trusted",
		category: "market",
		sequence: 20,
		objective: "Check whether any open exposure looks unsafe, stale, or too concentrated by morning.",
		deliverable: "a color-coded overnight risk status with the smallest specific morning action if risk is elevated",
		score(snapshot) {
			const signal = snapshot.themeCounts.trading;
			const failures = snapshot.statusCounts.failed;
			if (signal === 0) return { score: 0, reason: "No recent portfolio or market activity to justify a dedicated risk watch." };
			return {
				score: 28 + Math.min(signal, 5) * 4 + Math.min(failures, 3) * 3,
				reason: `Recent market-facing work plus ${failures} failed tasks make a concrete overnight risk read worth carrying into the morning.`,
			};
		},
	},
	{
		id: "ovn-003",
		title: "Queue Self-Heal Pass",
		priority: "high",
		zone: "trusted",
		category: "maintenance",
		sequence: 30,
		objective: "Quietly reduce queue drift by retrying only recoverable work and clarifying what is still blocked.",
		deliverable: "a short cleanup report covering retries, repairs, and unresolved blockers",
		score(snapshot) {
			const pressure = snapshot.queueTotals.pending + snapshot.queueTotals.blocked + snapshot.queueTotals.failed;
			return {
				score: 36 + Math.min(pressure, 18) * 2,
				reason: `The current queue is carrying ${snapshot.queueTotals.pending} pending, ${snapshot.queueTotals.blocked} blocked, and ${snapshot.queueTotals.failed} failed tasks, so a conservative self-heal pass has immediate leverage.`,
			};
		},
	},
	{
		id: "ovn-004",
		title: "Blocked Work Triage",
		priority: "normal",
		zone: "trusted",
		category: "maintenance",
		sequence: 40,
		objective: "Turn the highest-friction blocked work into one or two sharply defined next moves.",
		deliverable: "a ranked blocked-work triage with the clearest unblock paths",
		score(snapshot) {
			const blocked = snapshot.queueTotals.blocked;
			if (blocked === 0) return { score: 6, reason: "The queue is mostly unblocked, so blocked-work triage is optional tonight." };
			return {
				score: 18 + Math.min(blocked, 8) * 6,
				reason: `${blocked} tasks are blocked right now, which is enough friction to justify a dedicated unblock pass overnight.`,
			};
		},
	},
	{
		id: "ovn-005",
		title: "Memory Consolidation Pass",
		priority: "normal",
		zone: "trusted",
		category: "learning",
		sequence: 50,
		objective: "Reduce clutter and preserve the few lessons from recent work that should actually survive tomorrow.",
		deliverable: "a memory cleanup summary with durable lessons and anything that still needs verification",
		score(snapshot) {
			const completed = snapshot.statusCounts.completed;
			return {
				score: 18 + Math.min(completed, 10) * 4,
				reason: `${completed} tasks completed in the recent lookback, so there is enough new signal to justify an overnight consolidation pass.`,
			};
		},
	},
	{
		id: "ovn-006",
		title: "Focused Research Sprint",
		priority: "normal",
		zone: "trusted",
		category: "learning",
		sequence: 60,
		objective: "Spend one deep overnight block on the highest-value open gap slowing execution.",
		deliverable: "one evidence-backed recommendation and one justified follow-up task if warranted",
		score(snapshot) {
			const failures = snapshot.statusCounts.failed;
			const research = snapshot.themeCounts.research;
			return {
				score: 16 + Math.min(failures, 6) * 4 + Math.min(research, 4) * 2,
				reason: `Recent failures and open research-shaped gaps suggest one tightly scoped overnight research sprint will improve tomorrow's execution.`,
			};
		},
	},
	{
		id: "ovn-007",
		title: "Self-Improvement Rule Update",
		priority: "normal",
		zone: "trusted",
		category: "learning",
		sequence: 70,
		objective: "Convert tonight's repeated friction into one stronger operating rule for tomorrow.",
		deliverable: "one candid improvement note, one new rule, and one next experiment",
		score(snapshot) {
			const failures = snapshot.statusCounts.failed;
			const repeatedFailureClasses = snapshot.topFailureClasses.length;
			return {
				score: 20 + Math.min(failures, 5) * 4 + Math.min(repeatedFailureClasses, 3) * 3,
				reason: `Repeated friction is visible in the recent queue, so tonight should end with one explicit operating rule instead of another vague lesson.`,
			};
		},
	},
	{
		id: "ovn-008",
		title: "Morning Operator Handoff",
		priority: "high",
		zone: "trusted",
		category: "handoff",
		sequence: 999,
		objective: "Leave me a clean morning handoff so I can wake up and know exactly what matters first.",
		deliverable: "a brief morning packet covering what changed, what still needs attention, and the best first move",
		score() {
			return {
				score: 10_000,
				reason: "The pack always ends with a human-readable morning handoff.",
			};
		},
	},
	{
		id: "ovn-009",
		title: "Backlog Compression Sweep",
		priority: "normal",
		zone: "trusted",
		category: "maintenance",
		sequence: 45,
		objective: "Shrink non-essential backlog so tomorrow starts from a cleaner queue instead of inherited noise.",
		deliverable: "a ranked shortlist of what to keep moving, defer, or kill entirely",
		score(snapshot) {
			const pending = snapshot.queueTotals.pending;
			if (pending < 10) return { score: 8, reason: "The pending backlog is still manageable, so compression is useful but not urgent." };
			return {
				score: 18 + Math.min(pending, 20) * 3,
				reason: `There are ${pending} pending tasks in the queue, which makes overnight backlog compression a high-value cleanup step.`,
			};
		},
	},
	{
		id: "ovn-010",
		title: "Failure Pattern Review",
		priority: "normal",
		zone: "trusted",
		category: "quality",
		sequence: 65,
		objective: "Study the dominant failure pattern and turn repeated misses into one repair rule and one safer retry boundary.",
		deliverable: "a compact failure-pattern review with the dominant failure mode and the single most leverageful fix",
		score(snapshot) {
			const failures = snapshot.statusCounts.failed;
			const dominant = snapshot.topFailureClasses[0]?.count ?? 0;
			if (failures === 0) return { score: 6, reason: "No recent failures are accumulating, so pattern review can stay in reserve." };
			return {
				score: 20 + Math.min(failures, 8) * 4 + Math.min(dominant, 4) * 3,
				reason: `Recent failures are clustering enough to justify a dedicated failure-pattern review before the next day begins.`,
			};
		},
	},
	{
		id: "ovn-011",
		title: "Test and CI Debt Sweep",
		priority: "normal",
		zone: "trusted",
		category: "quality",
		sequence: 55,
		objective: "Use a quiet overnight block to identify the test or CI friction most likely to slow tomorrow's changes.",
		deliverable: "a testing-debt note with the highest-value fix and the smallest safe next action",
		score(snapshot) {
			const testing = snapshot.themeCounts.testing;
			if (testing === 0) return { score: 0, reason: "Recent work is not test-heavy enough to warrant a dedicated CI sweep tonight." };
			return {
				score: 18 + Math.min(testing, 6) * 5,
				reason: `Recent work referenced tests or CI ${testing} times, so a focused debt sweep should pay off quickly.`,
			};
		},
	},
	{
		id: "ovn-012",
		title: "Prompt and Procedure Hardening",
		priority: "normal",
		zone: "trusted",
		category: "quality",
		sequence: 75,
		objective: "Harden the prompts, runbooks, and procedures that caused drift, truncation, or repeated clarification loops.",
		deliverable: "one prompt or procedure patch recommendation with the exact weakness it fixes",
		score(snapshot) {
			const quality = snapshot.themeCounts.quality + snapshot.themeCounts.docs;
			if (quality === 0) return { score: 8, reason: "Prompt and procedure debt is present but not dominant in the current history." };
			return {
				score: 16 + Math.min(quality, 8) * 4,
				reason: `Recent work shows enough prompt, runbook, or truncation signal to justify hardening the operator procedures overnight.`,
			};
		},
	},
];

function safeReadJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function loadOperatorConfig() {
	const configRoot = process.env.ZARAA_CONFIG_DIR ?? join(homedir(), ".zaraa");
	const preferred = join(configRoot, "zaraa.config.json");
	const fallback = join(configRoot, "config.json");
	const path = existsSync(preferred) ? preferred : fallback;
	return {
		configPath: path,
		config: safeReadJson(path) ?? {},
	};
}

export function resolveOvernightWindow(config = {}) {
	const overnight = config?.scheduler?.overnight ?? {};
	const startHour = Number.isInteger(overnight.startHour) ? overnight.startHour : DEFAULT_OVERNIGHT_WINDOW.startHour;
	const endHour = Number.isInteger(overnight.endHour) ? overnight.endHour : DEFAULT_OVERNIGHT_WINDOW.endHour;
	return { startHour, endHour };
}

function resolveDataDir(config = {}) {
	if (process.env.ZARAA_DATA_DIR?.trim()) return process.env.ZARAA_DATA_DIR.trim();
	if (typeof config.dataDir === "string" && config.dataDir.trim()) {
		return config.dataDir.replace(/^~(?=\/|$)/, homedir());
	}
	return join(homedir(), ".zaraa", "data");
}

export function resolveTaskDbPath(config = {}) {
	if (process.env.ZARAA_TASK_DB?.trim()) return process.env.ZARAA_TASK_DB.trim();
	return join(resolveDataDir(config), "tasks.db");
}

function createEmptyStatusCounts() {
	return {
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		blocked: 0,
		cancelled: 0,
	};
}

function applyStatusCount(counts, status, amount = 1) {
	if (Object.prototype.hasOwnProperty.call(counts, status)) {
		counts[status] += amount;
	}
}

function addHours(date, hours) {
	return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function atLocalHour(baseDate, hour) {
	const d = new Date(baseDate);
	d.setHours(hour, 0, 0, 0);
	return d;
}

export function getMostRecentCompletedOvernightWindow(window, now = new Date()) {
	const end = atLocalHour(now, window.endHour);
	if (end.getTime() > now.getTime()) {
		end.setDate(end.getDate() - 1);
	}

	const start = atLocalHour(end, window.startHour);
	if (start.getTime() >= end.getTime()) {
		start.setDate(start.getDate() - 1);
	}

	return {
		start,
		end,
		label: `${start.toLocaleString()} -> ${end.toLocaleString()}`,
	};
}

function isWithinOvernightWindow(window, now = new Date()) {
	const start = atLocalHour(now, window.startHour);
	const end = atLocalHour(now, window.endHour);
	if (start.getTime() < end.getTime()) {
		return now.getTime() >= start.getTime() && now.getTime() < end.getTime();
	}
	return now.getTime() >= start.getTime() || now.getTime() < end.getTime();
}

function getCurrentOvernightWindow(window, now = new Date()) {
	const end = atLocalHour(now, window.endHour);
	if (end.getTime() <= now.getTime()) {
		end.setDate(end.getDate() + 1);
	}

	const start = atLocalHour(end, window.startHour);
	if (start.getTime() >= end.getTime()) {
		start.setDate(start.getDate() - 1);
	}

	return {
		start,
		end,
		label: `${start.toLocaleString()} -> ${end.toLocaleString()}`,
		inProgress: true,
	};
}

function getRelevantOvernightWindow(window, now = new Date()) {
	if (isWithinOvernightWindow(window, now)) {
		return getCurrentOvernightWindow(window, now);
	}
	return {
		...getMostRecentCompletedOvernightWindow(window, now),
		inProgress: false,
	};
}

function getEventTime(task) {
	return task.completedAt ?? task.startedAt ?? task.createdAt;
}

function textOf(task) {
	return `${task.prompt ?? ""}\n${task.result ?? ""}`;
}

function countTheme(rows, pattern) {
	let total = 0;
	for (const row of rows) {
		if (pattern.test(textOf(row))) total++;
	}
	return total;
}

function normalizeFailureClass(value) {
	return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function summarizeText(text, max = 120) {
	const compact = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!compact) return "No result captured.";
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function extractOperatorField(prompt, label) {
	const match = String(prompt ?? "").match(new RegExp(`^- ${label}:\\s*(.+)$`, "mi"));
	return match?.[1]?.trim() ?? null;
}

function inferTaskTitle(task) {
	const explicitTitle = extractOperatorField(task.prompt, "Title");
	if (explicitTitle) return explicitTitle;
	const prompt = String(task.prompt ?? "").toLowerCase();
	if (prompt.includes("market regime sweep")) return "Overnight Market Regime Sweep";
	if (prompt.includes("portfolio risk")) return "Overnight Portfolio Risk Watch";
	if (prompt.includes("queue") && prompt.includes("repair")) return "Queue Self-Heal Pass";
	if (prompt.includes("memory") && prompt.includes("consolidate")) return "Memory Consolidation Pass";
	if (prompt.includes("morning handoff")) return "Morning Operator Handoff";
	if (prompt.includes("self-improvement")) return "Self-Improvement Rule Update";
	if (prompt.includes("research sprint") || prompt.includes("research target")) return "Focused Research Sprint";
	return summarizeText(String(task.prompt ?? "").split("\n")[0] ?? "Untitled overnight task", 72);
}

function inferTaskKey(task) {
	const explicitId = extractOperatorField(task.prompt, "ID");
	if (explicitId) return explicitId;
	const title = inferTaskTitle(task);
	const blueprint = BLUEPRINTS.find((candidate) => candidate.title === title);
	return blueprint?.id ?? task.id;
}

function loadTaskHistory(config = {}, options = {}) {
	const taskDbPath = resolveTaskDbPath(config);
	const cutoff = new Date(Date.now() - (options.lookbackHours ?? HISTORY_LOOKBACK_HOURS) * 60 * 60 * 1000)
		.toISOString();
	const limit = options.limit ?? HISTORY_LIMIT;

	if (!existsSync(taskDbPath)) {
		return {
			available: false,
			taskDbPath,
			rows: [],
			queueTotals: createEmptyStatusCounts(),
			error: "Task database not found. Falling back to the default overnight pack.",
		};
	}

	let db;
	try {
		db = new Database(taskDbPath, { readonly: true });
		const rows = db.prepare(`
			SELECT
				t.id,
				t.prompt,
				t.status,
				t.result,
				t.createdAt,
				t.startedAt,
				t.completedAt,
				t.source,
				t.priority,
				t.zone,
				t.initiator,
				tm.failureClass AS failureClass,
				tm.qaStatus AS qaStatus,
				tm.cleanupBurden AS cleanupBurden
			FROM tasks t
			LEFT JOIN task_metadata tm ON tm.task_id = t.id
			WHERE t.createdAt >= ?
			ORDER BY t.createdAt DESC
			LIMIT ?
		`).all(cutoff, limit);

		const queueTotals = createEmptyStatusCounts();
		const queueRows = db.prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status").all();
		for (const row of queueRows) {
			applyStatusCount(queueTotals, row.status, row.count);
		}

		return {
			available: true,
			taskDbPath,
			rows,
			queueTotals,
			error: null,
		};
	} catch (error) {
		return {
			available: false,
			taskDbPath,
			rows: [],
			queueTotals: createEmptyStatusCounts(),
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		db?.close();
	}
}

function buildSnapshot(history, window) {
	const recentRows = history.rows;
	const overnightWindow = getRelevantOvernightWindow(window);
	const lastCompletedOvernightWindow = getMostRecentCompletedOvernightWindow(window);
	const overnightRows = recentRows.filter((row) => {
		const eventTime = new Date(getEventTime(row));
		return eventTime.getTime() >= overnightWindow.start.getTime()
			&& eventTime.getTime() <= overnightWindow.end.getTime()
			&& (row.source === "operator-overnight-pack" || /overnight|morning handoff|while i'm asleep/i.test(row.prompt ?? ""));
	});

	const statusCounts = createEmptyStatusCounts();
	for (const row of recentRows) {
		applyStatusCount(statusCounts, row.status, 1);
	}

	const overnightStatusCounts = createEmptyStatusCounts();
	for (const row of overnightRows) {
		applyStatusCount(overnightStatusCounts, row.status, 1);
	}

	const topFailureClasses = [...recentRows
		.filter((row) => row.status === "failed" || row.status === "blocked")
		.reduce((acc, row) => {
			const key = normalizeFailureClass(row.failureClass);
			acc.set(key, (acc.get(key) ?? 0) + 1);
			return acc;
		}, new Map())
		.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
		.slice(0, 3);

	const themeCounts = Object.fromEntries(
		Object.entries(THEME_PATTERNS).map(([name, pattern]) => [name, countTheme(recentRows, pattern)]),
	);

	const recentHighlights = recentRows
		.filter((row) => row.status === "completed")
		.slice(0, 3)
		.map((row) => ({
			id: row.id,
			title: inferTaskTitle(row),
			summary: summarizeText(row.result ?? row.prompt, 140),
		}));

	const overnightHighlights = overnightRows
		.filter((row) => row.status === "completed")
		.slice(0, 4)
		.map((row) => ({
			id: row.id,
			title: inferTaskTitle(row),
			summary: summarizeText(row.result ?? row.prompt, 140),
		}));

	const attentionItems = recentRows
		.filter((row) => row.status === "failed" || row.status === "blocked" || row.status === "running")
		.slice(0, 4)
		.map((row) => ({
			id: row.id,
			title: inferTaskTitle(row),
			status: row.status,
			summary: summarizeText(row.result ?? row.prompt, 140),
		}));

	const overnightAttentionItems = overnightRows
		.filter((row) => row.status === "failed" || row.status === "blocked" || row.status === "running")
		.slice(0, 4)
		.map((row) => ({
			id: row.id,
			title: inferTaskTitle(row),
			status: row.status,
			summary: summarizeText(row.result ?? row.prompt, 140),
		}));

	return {
		historyAvailable: history.available,
		historyError: history.error,
		taskDbPath: history.taskDbPath,
		window,
		overnightWindow,
		lastCompletedOvernightWindow,
		queueTotals: history.queueTotals,
		statusCounts,
		overnightStatusCounts,
		themeCounts,
		topFailureClasses,
		recentHighlights,
		overnightHighlights,
		attentionItems,
		overnightAttentionItems,
		recentRows,
		overnightRows,
	};
}

function selectBlueprints(snapshot, options = {}) {
	const desiredCount = Math.max(
		DEFAULT_MIN_TASKS,
		Math.min(
			options.maxTasks ?? DEFAULT_MAX_TASKS,
			snapshot.queueTotals.pending + snapshot.queueTotals.blocked + snapshot.queueTotals.failed >= 18
				? 8
				: snapshot.queueTotals.pending + snapshot.queueTotals.blocked + snapshot.queueTotals.failed >= 8
					? 7
					: 6,
		),
	);

	const scored = BLUEPRINTS.map((blueprint) => {
		const { score, reason } = blueprint.score(snapshot);
		return { ...blueprint, selectionScore: score, selectionReason: reason };
	});

	const selected = [];
	const selectedIds = new Set();

	function includeById(id) {
		const found = scored.find((candidate) => candidate.id === id);
		if (!found || selectedIds.has(id)) return;
		selected.push(found);
		selectedIds.add(id);
	}

	includeById("ovn-008");

	const sorted = scored
		.filter((candidate) => candidate.id !== "ovn-008")
		.sort((left, right) => right.selectionScore - left.selectionScore || left.sequence - right.sequence);

	for (const candidate of sorted) {
		if (selected.length >= desiredCount) break;
		if (candidate.selectionScore < 18) continue;
		includeById(candidate.id);
	}

	const categorySet = new Set(selected.map((task) => task.category));
	if (!categorySet.has("maintenance")) {
		includeById("ovn-003");
	}
	if (!categorySet.has("learning")) {
		includeById("ovn-007");
	}

	const fallbackOrder = ["ovn-003", "ovn-005", "ovn-006", "ovn-007", "ovn-001", "ovn-004", "ovn-009", "ovn-010", "ovn-011", "ovn-012", "ovn-002"];
	for (const id of fallbackOrder) {
		if (selected.length >= desiredCount) break;
		includeById(id);
	}

	return selected
		.sort((left, right) => left.sequence - right.sequence)
		.slice(0, desiredCount);
}

function formatQueueSummary(snapshot) {
	return `pending ${snapshot.queueTotals.pending}, blocked ${snapshot.queueTotals.blocked}, failed ${snapshot.queueTotals.failed}, completed ${snapshot.statusCounts.completed} in the recent lookback`;
}

function formatHistoryContext(snapshot) {
	const lines = [
		`- Queue snapshot: ${formatQueueSummary(snapshot)}.`,
		`- Recent themes: trading ${snapshot.themeCounts.trading}, testing ${snapshot.themeCounts.testing}, research ${snapshot.themeCounts.research}, procedure ${snapshot.themeCounts.docs + snapshot.themeCounts.quality}.`,
	];
	if (snapshot.topFailureClasses.length > 0) {
		lines.push(`- Top failure pattern: ${snapshot.topFailureClasses.map((item) => `${item.name} (${item.count})`).join(", ")}.`);
	}
	if (snapshot.recentHighlights.length > 0) {
		lines.push(`- Recent completed work worth remembering: ${snapshot.recentHighlights.map((item) => item.title).join("; ")}.`);
	}
	return lines;
}

function renderOperatorPrompt(task, snapshot) {
	return `Zaraa, I'm heading offline for the night and I want you to own this overnight work block.

Task:
- ID: ${task.id}
- Title: ${task.title}
- Priority: ${task.priority}
- Zone: ${task.zone}

Why this made tonight's queue:
- ${task.selectionReason}

Recent operating context:
${formatHistoryContext(snapshot).join("\n")}

What I need:
${task.objective}

Deliverable:
- Produce ${task.deliverable}.
- Use the real state of the codebase, task queue, memories, telemetry, or live tools wherever that helps.
- Be conservative with retries, claims, and conclusions.
- If you discover a durable lesson, turn it into a reusable rule, checklist, playbook, or tightly scoped follow-up task.

Overnight rules:
- Keep the signal high and the noise low.
- Prefer the smallest durable improvement over a dramatic but fragile move.
- If something is uncertain, label it plainly instead of smoothing it over.
- Work like I'm asleep and trusting you to keep the machine warm.

What I want back in the morning:
- The real situation.
- The single clearest risk or blocker, if one exists.
- The best first move when I get back online.
`;
}

function renderStructuredPrompt(task, snapshot) {
	return `[Overnight Operator Pack]
Task ID: ${task.id}
Title: ${task.title}
Priority: ${task.priority}
Zone: ${task.zone}

Selection reason:
${task.selectionReason}

Recent operating context:
- ${formatQueueSummary(snapshot)}
- Themes: trading ${snapshot.themeCounts.trading}, testing ${snapshot.themeCounts.testing}, research ${snapshot.themeCounts.research}, procedure ${snapshot.themeCounts.docs + snapshot.themeCounts.quality}

Objective:
${task.objective}

Required Deliverable:
- ${task.deliverable}
- Use real tool-backed or code-backed evidence.
- Preserve durable lessons as reusable procedures when justified.
- Name the clearest next action for the morning operator handoff.
`;
}

export function generateOvernightManifest(options = {}) {
	const { config } = loadOperatorConfig();
	const window = resolveOvernightWindow(config);
	const history = loadTaskHistory(config, options);
	const snapshot = buildSnapshot(history, window);
	const selectedBlueprints = selectBlueprints(snapshot, options);
	const tasks = selectedBlueprints.map((task, index) => ({
		...task,
		sequence: index + 1,
		operatorBrief: `${task.title}: ${task.objective}`,
		operatorPrompt: renderOperatorPrompt(task, snapshot),
		structuredPrompt: renderStructuredPrompt(task, snapshot),
		prompt: renderOperatorPrompt(task, snapshot),
	}));

	const manifest = {
		metadata: {
			generatedAt: new Date().toISOString(),
			defaultVoice: "operator",
			totalTasks: tasks.length,
			taskDbPath: snapshot.taskDbPath,
			historyAvailable: snapshot.historyAvailable,
			historyError: snapshot.historyError,
			selectionWindowHours: HISTORY_LOOKBACK_HOURS,
			lastCompletedOvernightWindow: snapshot.lastCompletedOvernightWindow.label,
			activeOvernightWindow: snapshot.overnightWindow.label,
			activeOvernightWindowInProgress: snapshot.overnightWindow.inProgress,
			queueTotals: snapshot.queueTotals,
			topFailureClasses: snapshot.topFailureClasses,
			themeCounts: snapshot.themeCounts,
		},
		tasks,
	};

	return { manifest, snapshot };
}

export function writeOvernightManifest(manifest) {
	mkdirSync(OUTPUT_DIR, { recursive: true });
	writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	writeFileSync(MARKDOWN_PATH, buildMarkdown(manifest), "utf8");
}

export function ensureFreshOvernightManifest(options = {}) {
	const { manifest } = generateOvernightManifest(options);
	writeOvernightManifest(manifest);
	return manifest;
}

export function selectManifestTasks(manifest, options) {
	let tasks = [...manifest.tasks];
	if (options.task) {
		tasks = tasks.filter((task) => task.id === options.task);
	}
	if (options.match) {
		const needle = normalize(options.match);
		tasks = tasks.filter((task) =>
			normalize([task.id, task.title, task.operatorBrief, task.objective, task.selectionReason].join(" ")).includes(needle),
		);
	}
	tasks.sort((a, b) => a.sequence - b.sequence);
	if (options.limit && options.limit > 0) {
		tasks = tasks.slice(0, options.limit);
	}
	return tasks;
}

function normalize(text) {
	return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function getTaskPrompt(task, voice) {
	return voice === "structured" ? task.structuredPrompt : task.operatorPrompt;
}

export function loadApiKey() {
	if (process.env.ZARAA_API_KEY) return process.env.ZARAA_API_KEY;
	const configRoot = process.env.ZARAA_CONFIG_DIR ?? join(homedir(), ".zaraa");
	const preferred = join(configRoot, "zaraa.config.json");
	const fallback = join(configRoot, "config.json");
	const path = existsSync(preferred) ? preferred : fallback;
	try {
		const config = JSON.parse(readFileSync(path, "utf8"));
		return config.gateway?.auth?.apiKey ?? config.apiKey ?? "";
	} catch {
		return "";
	}
}

export function buildMarkdown(manifest) {
	const queueTotals = manifest.metadata.queueTotals ?? createEmptyStatusCounts();
	const topFailures = Array.isArray(manifest.metadata.topFailureClasses) && manifest.metadata.topFailureClasses.length > 0
		? manifest.metadata.topFailureClasses.map((item) => `${item.name} (${item.count})`).join(", ")
		: "none";
	const lines = [
		"# Zaraa Overnight Operator Pack",
		"",
		"An adaptive overnight queue that reshapes itself around the recent task history instead of replaying a stale fixed packet.",
		"",
		`- Generated at: ${manifest.metadata.generatedAt}`,
		`- Total tasks: ${manifest.metadata.totalTasks}`,
		`- Default voice: ${manifest.metadata.defaultVoice}`,
		`- Task DB: ${manifest.metadata.taskDbPath}`,
		`- Recent queue snapshot: pending ${queueTotals.pending}, blocked ${queueTotals.blocked}, failed ${queueTotals.failed}, running ${queueTotals.running}`,
		`- Top failure classes: ${topFailures}`,
		`- Last completed overnight window: ${manifest.metadata.lastCompletedOvernightWindow}`,
		manifest.metadata.activeOvernightWindowInProgress ? `- Active overnight window: ${manifest.metadata.activeOvernightWindow} (in progress)` : null,
		manifest.metadata.historyError ? `- History note: ${manifest.metadata.historyError}` : null,
		"",
		"## Queue",
		"",
		...manifest.tasks.flatMap((task) => [
			`### ${task.id} — ${task.title}`,
			"",
			`- Priority: ${task.priority}`,
			`- Zone: ${task.zone}`,
			`- Selected because: ${task.selectionReason}`,
			"",
			"```text",
			task.operatorPrompt.trimEnd(),
			"```",
			"",
		]),
		"## Usage",
		"",
		"- Generate: `node scripts/generate-overnight-operator-pack.mjs`",
		"- Preview: `node scripts/submit-overnight-operator-pack.mjs --dry-run --preview=full`",
		"- Dispatch tonight's pack: `node scripts/submit-overnight-operator-pack.mjs`",
		"- Morning handoff: `node scripts/print-overnight-morning-handoff.mjs --full`",
		"",
	].filter(Boolean);

	return `${lines.join("\n")}\n`;
}

function pickFirstMeaningfulTask(rows, predicate) {
	return rows.find(predicate) ?? null;
}

function renderAttentionLines(snapshot, limit) {
	const source = snapshot.overnightAttentionItems.length > 0 ? snapshot.overnightAttentionItems : snapshot.attentionItems;
	if (source.length === 0) {
		return ["- No material overnight blockers surfaced in the recent history."];
	}
	return source.slice(0, limit).map((item) =>
		`- ${item.title} [${item.status}] — ${item.summary}`,
	);
}

function renderCompletedLines(snapshot, limit) {
	const source = snapshot.overnightHighlights.length > 0 ? snapshot.overnightHighlights : snapshot.recentHighlights;
	if (source.length === 0) {
		return ["- No recent completed work was captured in the lookback window."];
	}
	return source.slice(0, limit).map((item) =>
		`- ${item.title} — ${item.summary}`,
	);
}

function chooseFirstMove(snapshot) {
	const attention = snapshot.overnightAttentionItems.length > 0 ? snapshot.overnightAttentionItems : snapshot.attentionItems;
	const highlights = snapshot.overnightHighlights.length > 0 ? snapshot.overnightHighlights : snapshot.recentHighlights;
	const urgent = pickFirstMeaningfulTask(attention, (item) => item.status === "failed" || item.status === "blocked");
	if (urgent) {
		return `Review ${urgent.title} first, because the overnight queue still has unresolved ${urgent.status} work that is more important than starting something new.`;
	}
	if (snapshot.themeCounts.trading > 0) {
		return "Read the overnight market and risk outputs first so you can anchor the morning on the current regime before moving the queue.";
	}
	const highlight = highlights[0];
	if (highlight) {
		return `Start with ${highlight.title}, because it looks like the most leverageful completed overnight work to convert into forward motion.`;
	}
	return "Start by checking queue health and the latest handoff, because there is not enough strong overnight signal to justify a more specific first move.";
}

export function buildMorningHandoffReport(options = {}) {
	const { config } = loadOperatorConfig();
	const window = resolveOvernightWindow(config);
	const history = loadTaskHistory(config, options);
	const snapshot = buildSnapshot(history, window);
	const taskLimit = Math.max(1, options.limit ?? 4);
	const full = !!options.full;
	const lines = [
		"# Morning Operator Handoff",
		"",
		`- Window: ${snapshot.overnightWindow.label}${snapshot.overnightWindow.inProgress ? " (in progress)" : ""}`,
		`- Overnight tasks observed: ${snapshot.overnightRows.length}`,
		`- Queue now: pending ${snapshot.queueTotals.pending}, blocked ${snapshot.queueTotals.blocked}, failed ${snapshot.queueTotals.failed}, running ${snapshot.queueTotals.running}`,
		snapshot.historyError ? `- History note: ${snapshot.historyError}` : null,
		"",
		"## While you were asleep",
		"",
		...renderCompletedLines(snapshot, taskLimit),
		"",
		"## Still needs attention",
		"",
		...renderAttentionLines(snapshot, taskLimit),
		"",
		"## First move",
		"",
		chooseFirstMove(snapshot),
	];

	if (full) {
		lines.push(
			"",
			"## Signals",
			"",
			`- Theme counts: trading ${snapshot.themeCounts.trading}, testing ${snapshot.themeCounts.testing}, research ${snapshot.themeCounts.research}, procedure ${snapshot.themeCounts.docs + snapshot.themeCounts.quality}`,
			`- Recent status counts: completed ${snapshot.statusCounts.completed}, failed ${snapshot.statusCounts.failed}, blocked ${snapshot.statusCounts.blocked}, running ${snapshot.statusCounts.running}`,
			`- Top failure classes: ${snapshot.topFailureClasses.length > 0 ? snapshot.topFailureClasses.map((item) => `${item.name} (${item.count})`).join(", ") : "none"}`,
		);
	}

	return `${lines.filter(Boolean).join("\n")}\n`;
}
