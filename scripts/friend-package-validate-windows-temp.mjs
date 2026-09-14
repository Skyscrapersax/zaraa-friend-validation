#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFriendRuntimeSmoke } from "./friend-package-runtime-smoke.mjs";
import {
	assertPackageStructureValid,
	collectValidationProvenance,
	createValidationEnvironment,
	createValidationPath,
	fingerprintValidationFile,
	inspectFriendConfig,
	platformValidationExitCode,
	runCommandWithLog,
} from "./friend-package-validation-runner.mjs";
import { verifyFriendPackage } from "./friend-package-verify.mjs";

function parseArgs(argv) {
	const args = {
		cleanup: false,
		tempBase: "",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--cleanup") {
			args.cleanup = true;
			continue;
		}
		if (value === "--temp-base") {
			args.tempBase = argv[index + 1] ?? "";
			index += 1;
		}
	}

	return args;
}

async function readJson(filePath) {
	return JSON.parse(await readFile(filePath, "utf8"));
}

export function planWindowsTempValidation({ root = process.cwd(), version, tempBase }) {
	if (!version) {
		throw new Error("planWindowsTempValidation requires a package version.");
	}
	if (!tempBase) {
		throw new Error("planWindowsTempValidation requires a tempBase.");
	}

	const packageDirectory = path.join(root, "dist", "friend-package", `zaraa-harness-${version}`);
	const installer = path.join(packageDirectory, "installers", "install-windows.ps1");
	const homeDir = path.join(tempBase, "home");
	const zaraaDir = path.join(tempBase, "install", "zaraa");
	const pnpmHome = path.join(tempBase, "pnpm");

	return {
		root,
		version,
		tempBase,
		packageDirectory,
		installer,
		reportPath: path.join(
			root,
			".validation",
			`windows-clean-install-validation-${version}.json`,
		),
		logPath: path.join(tempBase, "install-output.log"),
		provenanceLogPath: path.join(tempBase, "pnpm-version.log"),
		env: {
			CI: "1",
			USERPROFILE: homeDir,
			ZARAA_HOME_DIR: homeDir,
			ZARAA_DIR: zaraaDir,
			COREPACK_HOME: path.join(tempBase, "corepack"),
			PNPM_HOME: pnpmHome,
			TEMP: path.join(tempBase, "tmp"),
			TMP: path.join(tempBase, "tmp"),
			APPDATA: path.join(tempBase, "appdata"),
			LOCALAPPDATA: path.join(tempBase, "localappdata"),
			XDG_DATA_HOME: path.join(tempBase, "data"),
			XDG_STATE_HOME: path.join(tempBase, "state"),
			npm_config_cache: path.join(tempBase, "npm-cache"),
			npm_config_store_dir: path.join(tempBase, "pnpm-store"),
			npm_config_userconfig: path.join(tempBase, "npmrc"),
			PATH: createValidationPath(pnpmHome),
		},
	};
}

async function preparePlanDirs(plan) {
	await mkdir(plan.env.USERPROFILE, { recursive: true });
	await mkdir(plan.env.ZARAA_DIR, { recursive: true });
	await mkdir(plan.env.COREPACK_HOME, { recursive: true });
	await mkdir(plan.env.PNPM_HOME, { recursive: true });
	await mkdir(plan.env.TEMP, { recursive: true });
	await mkdir(plan.env.APPDATA, { recursive: true });
	await mkdir(plan.env.LOCALAPPDATA, { recursive: true });
	await mkdir(plan.env.XDG_DATA_HOME, { recursive: true });
	await mkdir(plan.env.XDG_STATE_HOME, { recursive: true });
	await mkdir(plan.env.npm_config_cache, { recursive: true });
	await mkdir(plan.env.npm_config_store_dir, { recursive: true });
}

async function writeEvidence(
	plan,
	result,
	runtimeSmoke,
	configSafety,
	provenance,
	packageGeneratedAt,
	realZaraaConfigTouched,
) {
	const exists = (filePath) => existsSync(filePath);
	const passed =
		result.exitCode === 0 &&
		runtimeSmoke.status === "pass" &&
		configSafety.status === "pass" &&
		realZaraaConfigTouched === false;
	const evidence = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		platform: "Windows",
		validation: "clean-temp-folder-install",
		version: plan.version,
		packageGeneratedAt,
		status: passed ? "pass" : "fail",
		provenance,
		safeBoundaries: {
			installer: plan.installer,
			packageDirectory: plan.packageDirectory,
			tempBase: plan.tempBase,
			userProfileOverride: plan.env.USERPROFILE,
			homeOverride: plan.env.ZARAA_HOME_DIR,
			zaraaDirOverride: plan.env.ZARAA_DIR,
			realUserProfileTouched: false,
			realHomeTouched: false,
			realZaraaConfigTouched,
			cleanupRequired: true,
		},
		command:
			"USERPROFILE=<temp>/home ZARAA_HOME_DIR=<temp>/home ZARAA_DIR=<temp>/install/zaraa COREPACK_HOME=<temp>/corepack PNPM_HOME=<temp>/pnpm XDG_DATA_HOME=<temp>/data XDG_STATE_HOME=<temp>/state npm_config_cache=<temp>/npm-cache npm_config_store_dir=<temp>/pnpm-store npm_config_userconfig=<temp>/npmrc powershell.exe -NoProfile -ExecutionPolicy Bypass -File installers/install-windows.ps1 -ZaraaDir <temp>/install/zaraa",
		exitCode: passed ? 0 : result.exitCode || 1,
		evidence: {
			targetExists: exists(plan.env.ZARAA_DIR),
			tempConfigExists: exists(path.join(plan.env.ZARAA_HOME_DIR, ".zaraa", "zaraa.config.json")),
			packageJsonExists: exists(path.join(plan.env.ZARAA_DIR, "package.json")),
			installedReleaseMarkerExists: exists(
				path.join(plan.env.ZARAA_DIR, ".zaraa-installed-release.json"),
			),
			nodeModulesExists: exists(path.join(plan.env.ZARAA_DIR, "node_modules")),
			startScriptExists: exists(
				path.join(plan.packageDirectory, "installers", "start-windows.ps1"),
			),
			friendInstallDocExists: exists(path.join(plan.packageDirectory, "FRIEND_INSTALL.md")),
			gatewayStarted: runtimeSmoke.ready,
			dashboardRoutesPassed: runtimeSmoke.routesPassed,
		},
		runtimeSmoke: {
			status: runtimeSmoke.status,
			checks: runtimeSmoke.checks,
			logPath: runtimeSmoke.logPath,
		},
		configSafety,
		logTail: [...result.output.split(/\r?\n/), ...runtimeSmoke.logTail].slice(-30).filter(Boolean),
		cleanup: {
			note: "Temporary validation folder retained for inspection. Delete it manually when no longer needed.",
			tempBase: plan.tempBase,
		},
	};

	await mkdir(path.dirname(plan.reportPath), { recursive: true });
	await writeFile(plan.reportPath, `${JSON.stringify(evidence, null, 2)}\n`);
	return evidence;
}

async function main() {
	if (process.platform !== "win32") {
		throw new Error("ship:validate:windows-temp must be run on Windows.");
	}

	const args = parseArgs(process.argv.slice(2));
	const root = process.cwd();
	const latest = await readJson(path.join(root, "dist", "friend-package", "latest.json"));
	const verifyOptions = { root, evidenceRoot: path.join(root, ".validation"), writeReport: false, syncPublic: false };
	assertPackageStructureValid(verifyFriendPackage(verifyOptions));
	// --temp-base is a parent, never a directory we may erase wholesale.
	const tempBase = await mkdtemp(path.join(path.resolve(args.tempBase || tmpdir()), "zaraa-windows-clean-install."));
	const plan = planWindowsTempValidation({ root, version: latest.version, tempBase });

	if (!existsSync(plan.installer)) {
		throw new Error(`Missing Windows installer: ${path.relative(root, plan.installer)}`);
	}

	await preparePlanDirs(plan);
	const ownerConfigPath = path.join(homedir(), ".zaraa", "zaraa.config.json");
	const ownerConfigBefore = await fingerprintValidationFile(ownerConfigPath);
	const validationEnv = createValidationEnvironment(plan.env);
	const result = await runCommandWithLog(
		"powershell.exe",
		[
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			plan.installer,
			"-ZaraaDir",
			plan.env.ZARAA_DIR,
		],
		{
			cwd: plan.root,
			env: validationEnv,
			logPath: plan.logPath,
		},
	);
	const provenance = await collectValidationProvenance({
		cwd: plan.root,
		env: validationEnv,
		logPath: plan.provenanceLogPath,
	});
	const runtimeSmoke =
		result.exitCode === 0
			? await runFriendRuntimeSmoke({
					installDir: plan.env.ZARAA_DIR,
					tempBase: plan.tempBase,
					env: validationEnv,
				})
			: { status: "fail", ready: false, routesPassed: false, checks: [], logPath: "", logTail: [] };
	const configSafety = await inspectFriendConfig(
		path.join(plan.env.ZARAA_HOME_DIR, ".zaraa", "zaraa.config.json"),
	);
	const realZaraaConfigTouched =
		(await fingerprintValidationFile(ownerConfigPath)) !== ownerConfigBefore;
	const evidence = await writeEvidence(
		plan,
		result,
		runtimeSmoke,
		configSafety,
		provenance,
		latest.generatedAt,
		realZaraaConfigTouched,
	);
	const verification = verifyFriendPackage(verifyOptions);
	await writeFile(path.join(root, ".validation", "verification-Windows.json"), `${JSON.stringify(verification.report, null, 2)}\n`);

	if (args.cleanup) {
		await rm(plan.tempBase, { recursive: true, force: true });
	}

	console.log(`Windows temp install validation: ${evidence.status}`);
	console.log(`Package: ${plan.version}`);
	console.log(
		`Host: ${evidence.provenance.os.platform} ${evidence.provenance.os.release} (${evidence.provenance.architecture})`,
	);
	console.log(`Node: ${evidence.provenance.nodeVersion}`);
	console.log(`pnpm: ${evidence.provenance.pnpmVersion}`);
	console.log(`Report: ${path.relative(root, plan.reportPath)}`);
	console.log(`Temp folder: ${args.cleanup ? "removed" : plan.tempBase}`);
	console.log(`Ship status: ${verification.status}`);
	console.log(`Platform package gate: ${verification.safeToShare ? "pass" : "incomplete"}`);

	const exitCode = platformValidationExitCode({ evidence, verification, platform: "Windows" });
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
