#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	FRIEND_PACKAGE_LATEST_REL,
	missingFriendPackageLatestMessage,
} from "./friend-release-constants.mjs";

function readJson(root, path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Could not read ${relative(root, path)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function writeText(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function archiveLine(archive) {
	return `- \`${archive.file}\` (${archive.bytes} bytes)\n  SHA256: \`${archive.sha256}\``;
}

function platformLine(entry) {
	const report = entry.report ? ` Report: \`${entry.report}\`.` : "";
	return `- ${entry.platform}: ${entry.status}. ${entry.detail ?? ""}${report}`;
}

export function buildPlatformValidationHandoffMarkdown({
	version,
	channel,
	packageDirectory,
	archives,
	validation,
	sourceRevision,
	packageGeneratedAt,
}) {
	const matrixLines = (validation.platformMatrix ?? []).map(platformLine).join("\n");
	const blockers = validation.blockers ?? [];
	const blockerLines =
		blockers.length > 0
			? blockers.map((blocker) => `- ${blocker}`).join("\n")
			: "- No blockers recorded.";
	const archiveBlock =
		(archives ?? []).length > 0
			? archives.map(archiveLine).join("\n")
			: "- No archives listed in latest.json.";

	return `# Zaraa Platform Validation Handoff: ${version}

This is the exact handoff for validating the current trusted-friends package on macOS, Windows, and Linux.

## Current readiness

- Package: \`${version}\`
- Channel: \`${channel ?? "friends"}\`
- Status: \`${validation.status ?? "unknown"}\`
- Safe to share: \`${validation.safeToShare ? "yes" : "no"}\`
- Source revision: \`${sourceRevision ?? "unknown"}\`
- Package generated at: \`${packageGeneratedAt ?? "unknown"}\`

## Package files

Staged package folder:

\`\`\`text
dist/friend-package/${packageDirectory}
\`\`\`

Archives:

${archiveBlock}

## Platform matrix

${matrixLines}

## Not ready because

${blockerLines}

## What the tester should run

From a matching full repo checkout at exact source revision \`${sourceRevision ?? "unknown"}\` (the extracted friend package does not include validator scripts):

1. Verify transferred archive SHA256 against list above (\`Get-FileHash\` on Windows).
2. Put sender's unchanged \`latest.json\` and archives under \`dist/friend-package/\`.
3. Extract archive there so \`dist/friend-package/${packageDirectory}\` exists.
4. Run validator:

Validators use a temporary \`ZARAA_HOME_DIR\` for runtime state and leave process \`HOME\` unchanged.

\`\`\`bash
pnpm ship:validate:current-temp
pnpm ship:verify-package
\`\`\`

If the current-platform command is unavailable, use the explicit platform command for your OS:

\`\`\`bash
pnpm ship:validate:macos-temp
pnpm ship:validate:windows-temp
pnpm ship:validate:linux-temp
\`\`\`

## What the tester should send back

Send only:

- The generated report file: \`macos-clean-install-validation-${version}.json\`, \`windows-clean-install-validation-${version}.json\`, or \`linux-clean-install-validation-${version}.json\` (matching the platform you validated)
- The final terminal summary lines from the validation command
- OS name/version, CPU architecture, Node version, and pnpm version
- A short note saying whether the dashboard opened

Do not send:

- Gateway API keys
- \`~/.zaraa\` or \`.zaraa\` config contents
- Browser cookies, full logs, shell history, personal files, or screenshots with private data

## How Mama Zaraa records the returned report

Place the returned report in:

\`\`\`text
dist/friend-package/
\`\`\`

Then run:

\`\`\`bash
pnpm ship:import-validation-report -- dist/friend-package/macos-clean-install-validation-${version}.json
pnpm ship:import-validation-report -- dist/friend-package/windows-clean-install-validation-${version}.json
pnpm ship:import-validation-report -- dist/friend-package/linux-clean-install-validation-${version}.json
pnpm ship:verify-package
ZARAA_HOME_DIR=/absolute/isolated/home pnpm ship:promote:ready -- --runtime-root /path/to/installed/zaraa --gateway-url http://127.0.0.1:<candidate-port> --confirm-browser-smoke
\`\`\`

The promotion command must remain blocked until macOS, Windows, and Linux all have passing validation reports for \`${version}\`.
`;
}

/**
 * Writes platform-validation-handoff-{version}.md under dist/friend-package.
 * @param {{ root?: string, log?: boolean }} [options]
 * @returns {{ handoffPath: string, version: string, validation: object, text: string }}
 */
export function syncPlatformValidationHandoff(options = {}) {
	const root = options.root ?? process.cwd();
	const log = options.log !== false;
	const packageRoot = join(root, "dist", "friend-package");
	const latestPath = join(root, FRIEND_PACKAGE_LATEST_REL);
	const validationPath = join(packageRoot, "validation-report.json");

	if (!existsSync(latestPath)) {
		throw new Error(missingFriendPackageLatestMessage(relative(root, latestPath)));
	}

	const latest = readJson(root, latestPath);
	const validation = existsSync(validationPath)
		? readJson(root, validationPath)
		: {
				status: latest.validation?.status ?? "unknown",
				safeToShare: Boolean(latest.validation?.safeToShare),
				blockers: latest.validation?.blockers ?? [],
				platformMatrix: [],
			};

	const version = latest.version ?? "unknown";
	const packageDirectory = latest.package?.directory ?? `zaraa-harness-${version}`;
	const archives = latest.package?.archives ?? [];
	const handoffPath = join(packageRoot, `platform-validation-handoff-${version}.md`);
	const text = buildPlatformValidationHandoffMarkdown({
		version,
		channel: latest.channel,
		packageDirectory,
		archives,
		validation,
		sourceRevision: latest.source?.revision,
		packageGeneratedAt: latest.generatedAt,
	});

	writeText(handoffPath, text);

	if (log) {
		console.log("Zaraa platform validation handoff");
		console.log(`Package: ${version}`);
		console.log(`Status: ${validation.status ?? "unknown"}`);
		console.log(`Safe to share: ${validation.safeToShare ? "yes" : "no"}`);
		console.log(`Handoff: ${relative(root, handoffPath)}`);
	}

	return { handoffPath, version, validation, text };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	syncPlatformValidationHandoff();
}
