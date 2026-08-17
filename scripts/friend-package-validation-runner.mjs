import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, release as osRelease } from "node:os";
import { delimiter, dirname, resolve, sep } from "node:path";

const VALIDATION_HOST_ENV_KEYS = [
	"PATH",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"COLORTERM",
	"TZ",
];

export function assertPackageStructureValid(verification) {
	const failures = (verification?.checks ?? []).filter((check) => check.status === "FAIL");
	if (failures.length > 0) {
		throw new Error(
			`Friend package verification failed before install: ${failures
				.slice(0, 5)
				.map((check) => `${check.label}: ${check.detail}`)
				.join("; ")}`,
		);
	}
	return verification;
}

export function platformValidationExitCode({ evidence, verification, platform }) {
	if (!Number.isInteger(evidence?.exitCode) || evidence.exitCode !== 0) {
		return Number.isInteger(evidence?.exitCode) && evidence.exitCode > 0 ? evidence.exitCode : 1;
	}
	if ((verification?.checks ?? []).some((check) => check.status === "FAIL")) {
		return 1;
	}
	const platformResult = verification?.report?.platformMatrix?.find(
		(entry) => entry.platform === platform,
	);
	return platformResult?.status === "pass" ? 0 : 1;
}

/** Keep platform/runtime validation isolated from owner credentials and config overrides. */
export function createValidationEnvironment(overrides = {}, source = process.env) {
	const sourceByLowerKey = new Map(
		Object.entries(source).map(([key, value]) => [key.toLowerCase(), value]),
	);
	const env = {};
	for (const key of VALIDATION_HOST_ENV_KEYS) {
		const value = sourceByLowerKey.get(key.toLowerCase());
		if (typeof value === "string") env[key] = value;
	}
	return { ...env, ...overrides };
}

export async function fingerprintValidationFile(path) {
	try {
		return createHash("sha256").update(await readFile(path)).digest("hex");
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

/** Do not let a validator pass because it found an owner-global wrapper/tool. */
export function createValidationPath(
	prepend,
	hostPath = process.env.PATH ?? "",
	ownerHome = homedir(),
) {
	const normalizedHome = resolve(ownerHome).toLowerCase();
	const ownerPrefix = `${normalizedHome}${sep}`;
	const safeHostEntries = hostPath.split(delimiter).filter((entry) => {
		if (!entry) return false;
		const normalized = resolve(entry).toLowerCase();
		return normalized !== normalizedHome && !normalized.startsWith(ownerPrefix);
	});
	return [prepend, ...safeHostEntries].join(delimiter);
}

export async function collectValidationProvenance({
	cwd,
	env,
	logPath,
	platform = process.platform,
	release = osRelease(),
	architecture = process.arch,
	nodeVersion = process.version,
	runCommand = runCommandWithLog,
} = {}) {
	let pnpmVersion = "unavailable";
	try {
		const result = await runCommand("pnpm", ["--version"], { cwd, env, logPath });
		if (result.exitCode === 0) {
			pnpmVersion = result.output.trim() || pnpmVersion;
		}
	} catch {
		// Provenance is evidence only; it never changes install pass criteria.
	}

	return {
		os: { platform, release },
		architecture,
		nodeVersion,
		pnpmVersion,
	};
}

export async function runCommandWithLog(command, args, { cwd, env, logPath }) {
	await mkdir(dirname(logPath), { recursive: true });

	return new Promise((resolve) => {
		const logStream = createWriteStream(logPath, { flags: "w" });
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let output = "";
		let settled = false;
		const append = (chunk) => {
			const text = chunk.toString();
			output += text;
			logStream.write(text);
		};
		const finish = (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			logStream.end(() => {
				resolve({ exitCode, output });
			});
		};

		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("close", (code) => {
			finish(code ?? 1);
		});
		child.on("error", (error) => {
			append(error instanceof Error ? error.message : String(error));
			finish(1);
		});
	});
}

export async function inspectFriendConfig(configPath) {
	try {
		const config = JSON.parse(await readFile(configPath, "utf8"));
		const tasks = Array.isArray(config.scheduler?.tasks) ? config.scheduler.tasks : [];
		const checks = {
			gatewayKeyConfigured:
				typeof config.gateway?.auth?.apiKey === "string" && config.gateway.auth.apiKey.length >= 32,
			gatewayTrustedDisabled: config.gateway?.trusted === false,
			autonomyDisabled: config.autonomy?.mode === "off",
			minimalUntilProviderSetup: config.performance === "minimal",
			scheduledTasksDisabled: tasks.length > 0 && tasks.every((task) => task?.enabled === false),
			overnightDisabled: config.scheduler?.overnight?.enabled === false,
			tradingPaperOnly:
				config.trading?.paperMode === true && config.trading?.autoExecuteLive === false,
			tradingBackgroundDisabled: config.trading?.backgroundAutomation === false,
			predictionsPaperOnly:
				config.predictions?.paperMode === true && config.predictions?.autoExecuteLive === false,
			calendarDisabled: config.calendar?.enabled === false,
			imessageDisabled: config.messaging?.imessage?.enabled === false,
			voiceDisabled: config.voice?.enabled === false && config.voice?.facetime?.enabled === false,
		};
		return {
			status: Object.values(checks).every(Boolean) ? "pass" : "fail",
			checks,
		};
	} catch (error) {
		return {
			status: "fail",
			checks: {},
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
