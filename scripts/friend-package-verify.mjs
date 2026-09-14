#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, inflateRawSync } from "node:zlib";

import {
	FRIEND_PACKAGE_LATEST_REL,
	friendPackageStagingShouldSkipEntry,
	inspectFriendReleaseSource,
	missingFriendPackageLatestMessage,
} from "./friend-release-constants.mjs";
// Safe to import: the handoff module depends only on node builtins and
// friend-release-constants, so this does not create a cycle back into verify.
import { syncPlatformValidationHandoff } from "./friend-package-validation-handoff.mjs";
import { scanTextForSecrets } from "./zaraa-secret-scan.mjs";

/** A mirror may differ in Git HEAD only; dirty inputs and missing identity still fail. */
export function matchesMirrorIdentity({ issues, marker, stagedRevision, currentRevision, latest, manifestSha256 }) {
	return issues.length > 0
		&& issues.every(issue => /^source HEAD [a-f0-9]{40} differs from (?:staged|current) manifest revision [a-f0-9]{40}$/.test(issue))
		&& /^[a-f0-9]{40}$/.test(stagedRevision ?? "")
		&& marker?.canonicalRevision === stagedRevision
		&& latest?.source?.revision === stagedRevision && latest.source.clean === true
		&& (!currentRevision || currentRevision === stagedRevision)
		&& marker?.packageGeneratedAt === latest?.generatedAt
		&& /^[a-f0-9]{64}$/.test(manifestSha256 ?? "")
		&& marker?.manifestSha256 === manifestSha256;
}

/** Text surfaces scanned for secret-shaped content inside the staged friend kit. */
const STAGED_SECRET_SCAN_EXTENSIONS = new Set([
	".md",
	".mjs",
	".js",
	".cjs",
	".ts",
	".tsx",
	".sh",
	".ps1",
	".json",
	".jsonl",
	".yml",
	".yaml",
	".plist",
	".txt",
	".env",
	".toml",
	".html",
	".css",
	// Source maps can embed absolute owner/build-machine paths.
	".map",
]);
// Core friend ship chunk is ~4MB; a 2MB cap would skip the highest-risk surface.
const STAGED_SECRET_SCAN_MAX_BYTES = 12 * 1024 * 1024;

const REQUIRED_INSTALLERS = [
	["Installer: macOS/Linux", "installers/install-macos-linux.sh"],
	["Installer: Windows", "installers/install-windows.ps1"],
	["Starter: macOS/Linux", "installers/start-macos-linux.sh"],
	["Starter: Windows", "installers/start-windows.ps1"],
];

const REQUIRED_DOCS = [
	["Docs: install guide", "docs/friend-harness-install-guide.md"],
	["Docs: handoff README", "docs/friend-package-handoff.md"],
	["Docs: release notes template", "docs/friend-release-notes-template.md"],
	["Docs: known issues", "docs/friend-known-issues.md"],
	["Docs: platform validation", "docs/friend-platform-validation.md"],
	["Docs: platform validation handoff", "docs/friend-platform-validation-handoff.md"],
	["Docs: friend install quickstart", "FRIEND_INSTALL.md"],
	["Docs: start page", "START_HERE.html"],
];

const REQUIRED_RUNTIME = [
	["Runtime: core launcher", "packages/core/dist/launcher.js"],
	["Runtime: web dashboard", "packages/web/dist/index.html"],
	["Runtime: CLI zaraa", "packages/cli/dist/zaraa.js"],
	["Runtime: CLI zaraacoder", "packages/cli/dist/zaraacoder.js"],
	["Runtime: DeerFlow compatibility wrapper", "packages/deerflow-compat/index.js"],
	["Runtime: prediction native fallback wrapper", "packages/predict/index.js"],
	["Runtime: trading kernel fallback wrapper", "packages/trading-kernel/index.cjs"],
	["Runtime: daemon", "scripts/zaraa-daemon.mjs"],
	["Runtime: daemon helpers", "scripts/zaraa-daemon-lib.mjs"],
	["Runtime: restart intent", "scripts/lib/restart-intent.mjs"],
	["Runtime: installer updater", "scripts/friend-kit-update.mjs"],
	["Runtime: config money-rail pin", "scripts/friend-config-safety.mjs"],
	["Runtime: install preflight", "scripts/friend-build-preflight.mjs"],
	["Runtime: preflight policy", "scripts/friend-build-preflight-policy.mjs"],
	["Runtime: package verifier", "scripts/friend-package-verify.mjs"],
	["Runtime: release policy", "scripts/friend-release-constants.mjs"],
	// verifyFriendPackage imports this for staged content secret scan (must ship beside the verifier).
	["Runtime: secret scan library", "scripts/zaraa-secret-scan.mjs"],
];

const UPDATE_CHANNELS = [
	{
		label: "Master",
		source: "Mama Zaraa optimization lane",
		guardrail: "Can move quickly, but must not auto-ship to friends.",
	},
	{
		label: "Beta",
		source: "Promoted master snapshot",
		guardrail:
			"Requires build, preflight, package, package verification, and browser smoke evidence.",
	},
	{
		label: "Friends",
		source: "Validated beta package",
		guardrail: "Requires installer proof, rollback notes, and support guidance before sharing.",
	},
	{
		label: "Stable",
		source: "Repeatedly validated friends releases",
		guardrail: "Comes later, after normal use proves recovery and update behavior.",
	},
];

const PROMOTION_CHECKLIST = [
	"Run pnpm --filter @zaraa/web build.",
	"Run pnpm ship:ready.",
	"Run pnpm ship:package.",
	"Run pnpm ship:verify-package.",
	"Browser-smoke Ship Readiness, Cockpit, Dashboard, and Brain Map.",
	"Validate macOS install in a clean temporary folder.",
	"Validate Windows install path on a real machine or VM.",
	"Validate Linux install path on a real machine or VM.",
	"Attach release notes, known issues, rollback notes, and support template.",
];

const RUNBOOK_LINKS = [
	{ label: "Install guide", path: "docs/friend-harness-install-guide.md" },
	{ label: "Handoff README", path: "docs/friend-package-handoff.md" },
	{ label: "Release notes template", path: "docs/friend-release-notes-template.md" },
	{ label: "Known issues", path: "docs/friend-known-issues.md" },
	{ label: "Platform validation", path: "docs/friend-platform-validation.md" },
	{ label: "Platform validation handoff", path: "docs/friend-platform-validation-handoff.md" },
];

const FINAL_HUMAN_CHECKLIST = [
	"Package metadata matches the archives being shared.",
	"Package docs are inside the staged folder and archives.",
	"Hashes have been checked after archive creation.",
	"No local keys, configs, logs, memories, or private files are included.",
	"At least one clean-folder install has been validated before friend sharing.",
	"Rollback and support instructions are included with the package.",
];

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { __error: error instanceof Error ? error.message : String(error) };
	}
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileSize(path) {
	return statSync(path).size;
}

function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function crc32Bytes(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function addInventoryEntry(inventory, path, entry) {
	const existing = inventory.get(path);
	if (existing?.synthetic && entry.type === "directory") {
		inventory.set(path, entry);
		return;
	}
	if (existing) throw new Error(`duplicate archive path: ${path}`);
	inventory.set(path, entry);
}

function addArchiveParents(inventory, path) {
	const parts = path.split("/");
	for (let index = 1; index < parts.length; index += 1) {
		const parent = parts.slice(0, index).join("/");
		const existing = inventory.get(parent);
		if (existing && existing.type !== "directory") {
			throw new Error(`archive path parent is not a directory: ${parent}`);
		}
		if (!existing) {
			inventory.set(parent, { type: "directory", mode: null, synthetic: true });
		}
	}
}

function normalizeArchivePath(rawPath, packageDirectory) {
	let path = String(rawPath ?? "").replaceAll("\\", "/");
	while (path.startsWith("./")) path = path.slice(2);
	if (path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
		throw new Error(`unsafe archive path: ${JSON.stringify(rawPath)}`);
	}
	path = path.replace(/\/+$/, "");
	if (path === packageDirectory) return null;
	const prefix = `${packageDirectory}/`;
	if (!path.startsWith(prefix)) {
		throw new Error(`archive path is outside ${packageDirectory}: ${path}`);
	}
	const relativePath = path.slice(prefix.length);
	const segments = relativePath.split("/");
	if (
		relativePath.length === 0 ||
		segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
	) {
		throw new Error(`unsafe archive path: ${path}`);
	}
	return relativePath;
}

export function portableStageMode(mode, platform = process.platform) {
	return platform === "win32" ? null : mode & 0o777;
}

function stageInventory(stageDir) {
	const inventory = new Map();
	const walk = (directory, relativeDir = "") => {
		for (const name of readdirSync(directory).sort()) {
			const absolutePath = join(directory, name);
			const relativePath = relativeDir ? `${relativeDir}/${name}` : name;
			const stats = lstatSync(absolutePath);
			const mode = portableStageMode(stats.mode);
			if (stats.isDirectory()) {
				inventory.set(relativePath, { type: "directory", mode });
				walk(absolutePath, relativePath);
			} else if (stats.isFile()) {
				const bytes = readFileSync(absolutePath);
				inventory.set(relativePath, {
					type: "file",
					mode,
					bytes: bytes.length,
					sha256: sha256Bytes(bytes),
				});
			} else if (stats.isSymbolicLink()) {
				inventory.set(relativePath, {
					type: "symlink",
					mode,
					target: readlinkSync(absolutePath),
				});
			} else {
				inventory.set(relativePath, { type: "other", mode });
			}
		}
	};
	walk(stageDir);
	return inventory;
}

function tarText(buffer, offset, length) {
	return buffer
		.subarray(offset, offset + length)
		.toString("utf8")
		.replace(/\0.*$/s, "")
		.trim();
}

function tarNumber(buffer, offset, length) {
	const field = buffer.subarray(offset, offset + length);
	if ((field[0] & 0x80) !== 0) {
		let value = BigInt(field[0] & 0x7f);
		for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("tar numeric field is too large");
		return Number(value);
	}
	const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
	if (!text) return 0;
	if (!/^[0-7]+$/.test(text)) throw new Error(`invalid tar numeric field: ${text}`);
	return Number.parseInt(text, 8);
}

function parsePaxRecords(bytes) {
	const records = {};
	let offset = 0;
	while (offset < bytes.length) {
		const space = bytes.indexOf(0x20, offset);
		if (space < 0) throw new Error("malformed PAX record length");
		const length = Number.parseInt(bytes.subarray(offset, space).toString("ascii"), 10);
		if (!Number.isInteger(length) || length <= 0 || offset + length > bytes.length) {
			throw new Error("malformed PAX record");
		}
		const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
		const equals = record.indexOf("=");
		if (equals <= 0) throw new Error("malformed PAX key/value");
		records[record.slice(0, equals)] = record.slice(equals + 1);
		offset += length;
	}
	return records;
}

function tarArchiveInventory(archivePath, packageDirectory) {
	const archive = gunzipSync(readFileSync(archivePath));
	const inventory = new Map();
	let offset = 0;
	let globalPax = {};
	let localPax = {};
	let longPath = null;
	let longLink = null;

	while (offset + 512 <= archive.length) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const storedChecksum = tarNumber(header, 148, 8);
		let computedChecksum = 0;
		for (let index = 0; index < header.length; index += 1) {
			computedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
		}
		if (storedChecksum !== computedChecksum) throw new Error("tar header checksum mismatch");

		const headerSize = tarNumber(header, 124, 12);
		const dataStart = offset + 512;
		const dataEnd = dataStart + headerSize;
		if (dataEnd > archive.length) throw new Error("truncated tar entry");
		const content = archive.subarray(dataStart, dataEnd);
		offset = dataStart + Math.ceil(headerSize / 512) * 512;

		const typeFlag = String.fromCharCode(header[156] || 0);
		if (typeFlag === "x" || typeFlag === "g") {
			const records = parsePaxRecords(content);
			if (typeFlag === "g") globalPax = { ...globalPax, ...records };
			else localPax = records;
			continue;
		}
		if (typeFlag === "L" || typeFlag === "K") {
			const value = content.toString("utf8").replace(/\0.*$/s, "");
			if (typeFlag === "L") longPath = value;
			else longLink = value;
			continue;
		}

		const pax = { ...globalPax, ...localPax };
		const prefix = tarText(header, 345, 155);
		const headerPath = [prefix, tarText(header, 0, 100)].filter(Boolean).join("/");
		const rawPath = pax.path ?? longPath ?? headerPath;
		const rawLink = pax.linkpath ?? longLink ?? tarText(header, 157, 100);
		const relativePath = normalizeArchivePath(rawPath, packageDirectory);
		localPax = {};
		longPath = null;
		longLink = null;
		if (relativePath === null) {
			if (typeFlag !== "5") {
				throw new Error(`tar package root is not a directory: ${packageDirectory}`);
			}
			continue;
		}
		addArchiveParents(inventory, relativePath);

		const mode = tarNumber(header, 100, 8) & 0o777;
		const effectiveSize = pax.size === undefined ? headerSize : Number(pax.size);
		if (
			!Number.isSafeInteger(effectiveSize) ||
			effectiveSize < 0 ||
			effectiveSize > content.length
		) {
			throw new Error(`invalid tar entry size for ${relativePath}`);
		}
		if (typeFlag === "\0" || typeFlag === "0" || typeFlag === "7") {
			const bytes = content.subarray(0, effectiveSize);
			addInventoryEntry(inventory, relativePath, {
				type: "file",
				mode,
				bytes: bytes.length,
				sha256: sha256Bytes(bytes),
			});
		} else if (typeFlag === "5") {
			addInventoryEntry(inventory, relativePath, { type: "directory", mode });
		} else if (typeFlag === "2") {
			addInventoryEntry(inventory, relativePath, {
				type: "symlink",
				mode,
				target: rawLink,
			});
		} else if (typeFlag === "1") {
			addInventoryEntry(inventory, relativePath, {
				type: "hardlink",
				mode,
				target: rawLink,
			});
		} else {
			throw new Error(`unsupported tar entry type ${JSON.stringify(typeFlag)} at ${relativePath}`);
		}
	}
	return inventory;
}

function zipEndOfCentralDirectory(archive) {
	const minimum = Math.max(0, archive.length - 65_557);
	for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
		if (
			archive.readUInt32LE(offset) === 0x06054b50 &&
			offset + 22 + archive.readUInt16LE(offset + 20) === archive.length
		) {
			return offset;
		}
	}
	throw new Error("ZIP end-of-central-directory record not found");
}

function zipArchiveInventory(archivePath, packageDirectory) {
	const archive = readFileSync(archivePath);
	const endOffset = zipEndOfCentralDirectory(archive);
	const disk = archive.readUInt16LE(endOffset + 4);
	const centralDisk = archive.readUInt16LE(endOffset + 6);
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralSize = archive.readUInt32LE(endOffset + 12);
	const centralOffset = archive.readUInt32LE(endOffset + 16);
	if (
		disk !== 0 ||
		centralDisk !== 0 ||
		entryCount === 0xffff ||
		centralSize === 0xffffffff ||
		centralOffset === 0xffffffff
	) {
		throw new Error("multi-disk or ZIP64 archives are unsupported");
	}
	if (centralOffset + centralSize > archive.length)
		throw new Error("truncated ZIP central directory");

	const inventory = new Map();
	let offset = centralOffset;
	for (let index = 0; index < entryCount; index += 1) {
		if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) {
			throw new Error("malformed ZIP central directory");
		}
		const versionMadeBy = archive.readUInt16LE(offset + 4);
		const flags = archive.readUInt16LE(offset + 8);
		const compression = archive.readUInt16LE(offset + 10);
		const expectedCrc = archive.readUInt32LE(offset + 16);
		const compressedSize = archive.readUInt32LE(offset + 20);
		const uncompressedSize = archive.readUInt32LE(offset + 24);
		const nameLength = archive.readUInt16LE(offset + 28);
		const extraLength = archive.readUInt16LE(offset + 30);
		const commentLength = archive.readUInt16LE(offset + 32);
		const externalAttributes = archive.readUInt32LE(offset + 38);
		const localOffset = archive.readUInt32LE(offset + 42);
		if (
			compressedSize === 0xffffffff ||
			uncompressedSize === 0xffffffff ||
			localOffset === 0xffffffff
		) {
			throw new Error("ZIP64 entries are unsupported");
		}
		if ((flags & (0x1 | 0x40)) !== 0) throw new Error("encrypted ZIP entries are unsupported");
		const nameStart = offset + 46;
		const nameEnd = nameStart + nameLength;
		if (nameEnd + extraLength + commentLength > archive.length) {
			throw new Error("truncated ZIP central entry");
		}
		const centralName = archive.subarray(nameStart, nameEnd);
		const rawPath = centralName.toString("utf8");
		offset = nameEnd + extraLength + commentLength;
		const relativePath = normalizeArchivePath(rawPath, packageDirectory);
		const displayPath = relativePath ?? packageDirectory;
		if (relativePath !== null) addArchiveParents(inventory, relativePath);

		if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
			throw new Error(`missing ZIP local header for ${displayPath}`);
		}
		const localFlags = archive.readUInt16LE(localOffset + 6);
		const localCompression = archive.readUInt16LE(localOffset + 8);
		const localNameLength = archive.readUInt16LE(localOffset + 26);
		const localExtraLength = archive.readUInt16LE(localOffset + 28);
		const localNameStart = localOffset + 30;
		const localNameEnd = localNameStart + localNameLength;
		if (localNameEnd + localExtraLength > archive.length) {
			throw new Error(`truncated ZIP local header for ${displayPath}`);
		}
		if (localFlags !== flags || localCompression !== compression) {
			throw new Error(`ZIP local/central flags or compression mismatch for ${displayPath}`);
		}
		if (!archive.subarray(localNameStart, localNameEnd).equals(centralName)) {
			throw new Error(`ZIP local/central name mismatch for ${displayPath}`);
		}
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const dataEnd = dataStart + compressedSize;
		if (dataEnd > archive.length) throw new Error(`truncated ZIP entry: ${displayPath}`);
		const compressed = archive.subarray(dataStart, dataEnd);
		const bytes =
			compression === 0
				? compressed
				: compression === 8
					? inflateRawSync(compressed)
					: (() => {
							throw new Error(`unsupported ZIP compression method ${compression}`);
						})();
		if (bytes.length !== uncompressedSize) {
			throw new Error(`ZIP size mismatch for ${displayPath}`);
		}
		if (crc32Bytes(bytes) !== expectedCrc) throw new Error(`ZIP CRC32 mismatch for ${displayPath}`);

		const creatorOs = versionMadeBy >>> 8;
		const unixMode = externalAttributes >>> 16;
		const mode = creatorOs === 3 && unixMode !== 0 ? unixMode & 0o777 : null;
		const unixType = unixMode & 0o170000;
		if (relativePath === null) {
			if (!rawPath.endsWith("/") && unixType !== 0o040000) {
				throw new Error(`ZIP package root is not a directory: ${packageDirectory}`);
			}
			continue;
		}
		if (rawPath.endsWith("/") || unixType === 0o040000) {
			addInventoryEntry(inventory, relativePath, { type: "directory", mode });
		} else if (creatorOs === 3 && unixType === 0o120000) {
			addInventoryEntry(inventory, relativePath, {
				type: "symlink",
				mode,
				target: bytes.toString("utf8"),
			});
		} else {
			addInventoryEntry(inventory, relativePath, {
				type: "file",
				mode,
				bytes: bytes.length,
				sha256: sha256Bytes(bytes),
			});
		}
	}
	return inventory;
}

function archiveInventory(archivePath, packageDirectory) {
	if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
		return tarArchiveInventory(archivePath, packageDirectory);
	}
	if (archivePath.endsWith(".zip")) return zipArchiveInventory(archivePath, packageDirectory);
	throw new Error(`unsupported archive format: ${archivePath}`);
}

export function compareArchiveToStage(stageDir, archivePath, packageDirectory, allowMissingEmptyDirectories = false) {
	const stage = stageInventory(stageDir);
	const archived = archiveInventory(archivePath, packageDirectory);
	const nonempty = new Set();
	for (const [name, entry] of archived) {
		if (entry.type === "directory") continue;
		const parts = name.split("/");
		for (let i = 1; i < parts.length; i++) nonempty.add(parts.slice(0, i).join("/"));
	}
	const paths = [...new Set([...stage.keys(), ...archived.keys()])].sort();
	const differences = [];
	for (const path of paths) {
		const expected = stage.get(path);
		const actual = archived.get(path);
		if (!expected) {
			// Git cannot store empty directories. Only a pinned mirror gets this exception;
			// missing files, symlinks and directories with content still fail.
			if (allowMissingEmptyDirectories && actual.type === "directory" && !nonempty.has(path)) continue;
			differences.push(`${path}: extra in archive`);
			continue;
		}
		if (!actual) {
			differences.push(`${path}: missing from archive`);
			continue;
		}
		if (expected.type !== actual.type) {
			differences.push(`${path}: type ${actual.type}, expected ${expected.type}`);
			continue;
		}
		if (actual.mode !== null && expected.mode !== null && expected.mode !== actual.mode) {
			differences.push(
				`${path}: mode ${actual.mode.toString(8)}, expected ${expected.mode.toString(8)}`,
			);
		}
		if (
			expected.type === "file" &&
			(expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256)
		) {
			differences.push(`${path}: file bytes differ`);
		}
		if (expected.type === "symlink" && expected.target !== actual.target) {
			differences.push(`${path}: symlink target differs`);
		}
	}
	return { entryCount: stage.size, differences };
}

function findUnsafeStagedPaths(dir, root = dir, findings = [], relativeDir = "") {
	const relDir = String(relativeDir || "")
		.replaceAll("\\", "/")
		.replace(/^\.\/?/, "")
		.replace(/\/$/, "");
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		const rel = relative(root, dir).replaceAll("\\", "/") || ".";
		findings.push(`${rel} (unreadable-dir)`);
		return findings;
	}
	for (const entry of entries) {
		const absPath = join(dir, entry);
		const relPath = relative(root, absPath).replaceAll("\\", "/");
		let stats;
		try {
			stats = lstatSync(absPath);
		} catch {
			findings.push(`${relPath} (unreadable)`);
			continue;
		}
		// Symlinks can point at owner home/secrets; never allow in staged kits.
		if (stats.isSymbolicLink()) {
			findings.push(`${relPath} (symlink)`);
			continue;
		}
		if (stats.isFile() && stats.nlink > 1) {
			findings.push(`${relPath} (hardlink)`);
			continue;
		}
		if (
			stats.isFile() &&
			stats.size === 0 &&
			!relPath.endsWith(".d.ts") &&
			!relPath.endsWith(".map")
		) {
			findings.push(`${relPath} (empty-file)`);
			continue;
		}
		// Path-aware: packages/<pkg>/src is forbidden in friend kits (dist-only).
		if (friendPackageStagingShouldSkipEntry(entry, relDir)) {
			findings.push(relPath);
			continue;
		}
		if (stats.isDirectory()) {
			const childRel = relDir ? `${relDir}/${entry}` : entry;
			findUnsafeStagedPaths(absPath, root, findings, childRel);
		}
	}
	return findings;
}

function hasStagedSecretScanExtension(filePath) {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return false;
	return STAGED_SECRET_SCAN_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

const OWNER_ACCOUNT = ["za", "raa"].join("");
/** Absolute owner-home paths must never ship inside a friend kit (POSIX + Windows; single or escaped \\). */
const OWNER_HOME_PATH_RE = new RegExp(
	String.raw`(?:/Users/${OWNER_ACCOUNT}|(?:C:)?\\+Users\\+${OWNER_ACCOUNT})(?:[\\/]|\b)`,
	"gi",
);
/** Owner affiliate repo path shape (enabled-by-default dist residue). */
const OWNER_AFFILIATE_PATH_RE = new RegExp(`${OWNER_ACCOUNT}-${["affil", "iate"].join("")}`, "gi");
/** Owner Amazon Associates tag residue (must not monetize friends' traffic). */
const OWNER_AMAZON_TAG_RE = new RegExp(["daily", "pick-", "20"].join(""), "gi");

/**
 * Honest content-scan policy: scan every staged text surface that is allowed to ship.
 * packages/<pkg>/src is omitted by packaging + path hygiene; if present it is forbidden, not scanned.
 * Test trees (__tests__, and *.test / *.spec files) must not ship (hygiene); exclude from content scan too.
 */
function isFriendShipContentScanPath(relPath) {
	const n = relPath.replaceAll("\\", "/");
	if (n.includes("/__tests__/") || n.includes("/__snapshots__/")) return false;
	if (/\.(?:test|spec)\.[^/]+$/i.test(n)) return false;
	// packages/<pkg>/src must not ship; never treat as a scanned surface (hygiene fails instead).
	if (/^packages\/[^/]+\/src(\/|$)/.test(n)) return false;
	if (n.startsWith("installers/")) return true;
	if (n === "FRIEND_INSTALL.md" || n === "START_HERE.html" || n === "package.json") return true;
	if (n.startsWith("docs/")) return true;
	if (n.startsWith("scripts/")) return true;
	// packages/* except src: dist, package.json, README, and other non-src roots.
	if (/^packages\//.test(n)) return true;
	// Plugins ship as source-ish trees.
	if (n.startsWith("plugins/")) return true;
	return false;
}

/**
 * Filesystem walk of staged kit text files (not git-backed).
 * Returns { scannedFiles, secretFindings, ownerPathFindings, scanErrors, oversizeFiles }.
 * Secret findings use maskSecret only (never raw secrets).
 * Fail-closed: readdir/stat/read errors and ship-surface files over MAX_BYTES are recorded
 * (a positive scannedFiles count alone does not prove full coverage).
 */
function scanStagedPackageContent(stageDir) {
	const secretFindings = [];
	const ownerPathFindings = [];
	const scanErrors = [];
	const oversizeFiles = [];
	let scannedFiles = 0;
	const skipDirs = new Set([
		"node_modules",
		".git",
		"coverage",
		".turbo",
		".vite",
		"__tests__",
		"__snapshots__",
	]);

	function walk(dir) {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			const rel = relative(stageDir, dir).replaceAll("\\", "/") || ".";
			scanErrors.push({ file: rel, reason: "readdir-failed" });
			return;
		}
		const relDir = relative(stageDir, dir).replaceAll("\\", "/");
		for (const entry of entries) {
			const absPath = join(dir, entry);
			const rel = relative(stageDir, absPath).replaceAll("\\", "/");
			let stats;
			try {
				// lstat: never follow symlinks into owner home / out-of-tree secrets.
				stats = lstatSync(absPath);
			} catch {
				scanErrors.push({ file: rel, reason: "stat-failed" });
				continue;
			}
			if (stats.isSymbolicLink()) {
				// Path hygiene also fails; treat as incomplete coverage if content walk reaches it.
				scanErrors.push({ file: rel, reason: "symlink" });
				continue;
			}
			if (stats.isDirectory()) {
				if (skipDirs.has(entry)) continue;
				// packages/*/src is a packaging hygiene violation; do not walk (path hygiene flags it).
				if (entry === "src" && (relDir === "packages" || /^packages\/[^/]+$/.test(relDir))) {
					continue;
				}
				walk(absPath);
				continue;
			}
			if (!stats.isFile() || !hasStagedSecretScanExtension(absPath)) continue;
			if (!isFriendShipContentScanPath(rel)) continue;
			if (stats.size > STAGED_SECRET_SCAN_MAX_BYTES) {
				// Do not claim coverage for unread ship-surface files.
				oversizeFiles.push({ file: rel, bytes: stats.size });
				continue;
			}
			let text;
			try {
				text = readFileSync(absPath, "utf8");
			} catch {
				scanErrors.push({ file: rel, reason: "read-failed" });
				continue;
			}
			scannedFiles++;
			secretFindings.push(...scanTextForSecrets(text, rel));

			// Report path/tag leaks without echoing surrounding context (may contain secrets).
			const hasOwnerHome = OWNER_HOME_PATH_RE.test(text);
			OWNER_HOME_PATH_RE.lastIndex = 0;
			const hasAffiliatePath = OWNER_AFFILIATE_PATH_RE.test(text);
			OWNER_AFFILIATE_PATH_RE.lastIndex = 0;
			const hasAmazonTag = OWNER_AMAZON_TAG_RE.test(text);
			OWNER_AMAZON_TAG_RE.lastIndex = 0;
			if (hasOwnerHome || hasAffiliatePath || hasAmazonTag) {
				const kinds = [];
				if (hasOwnerHome) kinds.push("owner-home-path");
				if (hasAffiliatePath) kinds.push("owner-affiliate-path");
				if (hasAmazonTag) kinds.push("owner-amazon-tag");
				ownerPathFindings.push({ file: rel, kinds });
			}
		}
	}

	walk(stageDir);
	return { scannedFiles, secretFindings, ownerPathFindings, scanErrors, oversizeFiles };
}

function incompleteContentScanDetail(contentScan) {
	const parts = [];
	if (contentScan.scanErrors.length > 0) {
		const sample = contentScan.scanErrors
			.slice(0, 3)
			.map((e) => `${e.file} (${e.reason})`)
			.join("; ");
		parts.push(
			`${contentScan.scanErrors.length} unreadable path(s): ${sample}${contentScan.scanErrors.length > 3 ? "; ..." : ""}`,
		);
	}
	if (contentScan.oversizeFiles.length > 0) {
		const sample = contentScan.oversizeFiles
			.slice(0, 3)
			.map((e) => `${e.file} (${e.bytes} bytes)`)
			.join("; ");
		parts.push(
			`${contentScan.oversizeFiles.length} oversize file(s) >${STAGED_SECRET_SCAN_MAX_BYTES} bytes skipped: ${sample}${contentScan.oversizeFiles.length > 3 ? "; ..." : ""}`,
		);
	}
	return parts.join(" | ");
}

function makeCheck(status, label, detail = "") {
	return { status, label, detail };
}

function releaseManifestRevision(manifest) {
	return manifest?.schemaVersion === 2 &&
		manifest.source?.vcs === "git" &&
		manifest.source?.clean === true &&
		typeof manifest.source?.revision === "string" &&
		/^[0-9a-f]{40,64}$/i.test(manifest.source.revision)
		? manifest.source.revision
		: null;
}

function requiredStagedFileCheck(stageDir, label, relPath) {
	const absPath = join(stageDir, relPath);
	try {
		const stats = lstatSync(absPath);
		return stats.isFile() && stats.size > 0
			? makeCheck("PASS", label, relPath)
			: makeCheck("FAIL", label, `${relPath} must be a non-empty regular file.`);
	} catch {
		return makeCheck("FAIL", label, `${relPath} is missing from the staged package.`);
	}
}

function normalizePlatformStatus(status) {
	if (status === "pass" || status === "fail" || status === "blocked") {
		return status;
	}
	return "untested";
}

const PLATFORM_PROVENANCE_OS = {
	macOS: "darwin",
	Windows: "win32",
	Linux: "linux",
};

const REQUIRED_INSTALL_EVIDENCE_FLAGS = [
	"targetExists",
	"tempConfigExists",
	"packageJsonExists",
	"installedReleaseMarkerExists",
	"nodeModulesExists",
	"startScriptExists",
	"friendInstallDocExists",
	"gatewayStarted",
	"dashboardRoutesPassed",
];

const REQUIRED_RUNTIME_SMOKE_ROUTES = ["/ship-readiness", "/cockpit", "/dashboard", "/brain-map"];

const REQUIRED_CONFIG_SAFETY_CHECKS = [
	"gatewayKeyConfigured",
	"gatewayTrustedDisabled",
	"autonomyDisabled",
	"minimalUntilProviderSetup",
	"scheduledTasksDisabled",
	"overnightDisabled",
	"tradingPaperOnly",
	"tradingBackgroundDisabled",
	"predictionsPaperOnly",
	"calendarDisabled",
	"imessageDisabled",
	"voiceDisabled",
];

function isValidTimestamp(value) {
	return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isNonemptyString(value) {
	return typeof value === "string" && value.trim().length > 0;
}

function passingPlatformEvidenceErrors(report, platform) {
	const errors = [];
	const expectedOs = PLATFORM_PROVENANCE_OS[platform];
	if (report.schemaVersion !== 1) errors.push("schemaVersion must be 1");
	if (report.validation !== "clean-temp-folder-install") {
		errors.push('validation must be "clean-temp-folder-install"');
	}
	const generatedAtValid = isValidTimestamp(report.generatedAt);
	const packageGeneratedAtValid = isValidTimestamp(report.packageGeneratedAt);
	if (!generatedAtValid) errors.push("generatedAt must be a valid timestamp");
	if (!packageGeneratedAtValid) errors.push("packageGeneratedAt must be a valid timestamp");
	if (
		generatedAtValid &&
		packageGeneratedAtValid &&
		Date.parse(report.generatedAt) < Date.parse(report.packageGeneratedAt)
	) {
		errors.push("generatedAt must not precede packageGeneratedAt");
	}
	if (report.provenance?.os?.platform !== expectedOs) {
		errors.push(`provenance.os.platform must be ${expectedOs}`);
	}
	if (!isNonemptyString(report.provenance?.os?.release)) {
		errors.push("provenance.os.release must be present");
	}
	if (!isNonemptyString(report.provenance?.architecture)) {
		errors.push("provenance.architecture must be present");
	}
	if (!isNonemptyString(report.provenance?.nodeVersion)) {
		errors.push("provenance.nodeVersion must be present");
	}
	if (!isNonemptyString(report.provenance?.pnpmVersion)) {
		errors.push("provenance.pnpmVersion must be present");
	}
	if (report.exitCode !== 0) errors.push("exitCode must be 0");
	for (const flag of REQUIRED_INSTALL_EVIDENCE_FLAGS) {
		if (report.evidence?.[flag] !== true) errors.push(`evidence.${flag} must be true`);
	}
	if (report.evidence && typeof report.evidence === "object" && !Array.isArray(report.evidence)) {
		for (const [flag, value] of Object.entries(report.evidence)) {
			if (
				!REQUIRED_INSTALL_EVIDENCE_FLAGS.includes(flag) &&
				typeof value === "boolean" &&
				value !== true
			) {
				errors.push(`evidence.${flag} must be true`);
			}
		}
	}
	if (report.runtimeSmoke?.status !== "pass") errors.push("runtimeSmoke.status must be pass");
	if (!Array.isArray(report.runtimeSmoke?.checks)) {
		errors.push("runtimeSmoke.checks must contain the four required routes");
	} else {
		if (report.runtimeSmoke.checks.length !== REQUIRED_RUNTIME_SMOKE_ROUTES.length) {
			errors.push("runtimeSmoke.checks must contain exactly four route checks");
		}
		for (const route of REQUIRED_RUNTIME_SMOKE_ROUTES) {
			const matchingChecks = report.runtimeSmoke.checks.filter((check) => check?.route === route);
			if (matchingChecks.length !== 1) {
				errors.push(`runtimeSmoke.checks must contain ${route} exactly once`);
			} else if (matchingChecks[0].status !== "pass") {
				errors.push(`runtimeSmoke.checks ${route} status must be pass`);
			}
		}
	}
	if (report.configSafety?.status !== "pass") errors.push("configSafety.status must be pass");
	const configSafetyChecks = report.configSafety?.checks;
	if (
		!configSafetyChecks ||
		typeof configSafetyChecks !== "object" ||
		Array.isArray(configSafetyChecks)
	) {
		errors.push("configSafety.checks must contain the required safety checks");
	} else {
		for (const check of REQUIRED_CONFIG_SAFETY_CHECKS) {
			if (configSafetyChecks[check] !== true) {
				errors.push(`configSafety.checks.${check} must be true`);
			}
		}
		for (const [check, value] of Object.entries(configSafetyChecks)) {
			if (
				!REQUIRED_CONFIG_SAFETY_CHECKS.includes(check) &&
				typeof value === "boolean" &&
				value !== true
			) {
				errors.push(`configSafety.checks.${check} must be true`);
			}
		}
	}
	if (report.safeBoundaries?.realHomeTouched !== false) {
		errors.push("safeBoundaries.realHomeTouched must be false");
	}
	if (report.safeBoundaries?.realZaraaConfigTouched !== false) {
		errors.push("safeBoundaries.realZaraaConfigTouched must be false");
	}
	if (report.safeBoundaries?.cleanupRequired !== true) {
		errors.push("safeBoundaries.cleanupRequired must be true");
	}
	if (platform === "Windows" && report.safeBoundaries?.realUserProfileTouched !== false) {
		errors.push("safeBoundaries.realUserProfileTouched must be false");
	}
	return errors;
}

function platformValidationEntry({
	root,
	packageRoot,
	platform,
	reportFile,
	version,
	packageGeneratedAt,
	defaultDetail,
}) {
	const reportPath = join(packageRoot, reportFile);
	if (!version || !existsSync(reportPath)) {
		return {
			platform,
			status: "untested",
			detail: defaultDetail,
		};
	}

	const report = readJson(reportPath);
	if (report.__error) {
		return {
			platform,
			status: "blocked",
			detail: `Could not parse ${reportFile}: ${report.__error}`,
			report: relative(root, reportPath),
		};
	}

	if (report.version !== version) {
		return {
			platform,
			status: "blocked",
			detail: `${reportFile} is for ${report.version ?? "unknown"}, not ${version}.`,
			report: relative(root, reportPath),
		};
	}
	if (report.platform !== platform) {
		return {
			platform,
			status: "blocked",
			detail: `${reportFile} reports ${report.platform ?? "an unknown platform"}, not ${platform}.`,
			report: relative(root, reportPath),
		};
	}

	if (!packageGeneratedAt || report.packageGeneratedAt !== packageGeneratedAt) {
		return {
			platform,
			status: "blocked",
			detail: `${reportFile} was generated for a different package build.`,
			report: relative(root, reportPath),
		};
	}

	const status = normalizePlatformStatus(report.status);
	if (status === "pass") {
		const evidenceErrors = passingPlatformEvidenceErrors(report, platform);
		if (evidenceErrors.length > 0) {
			return {
				platform,
				status: "blocked",
				detail: `${reportFile} cannot count as pass: ${evidenceErrors.join("; ")}.`,
				report: relative(root, reportPath),
			};
		}
	}
	const action =
		status === "pass"
			? "passed"
			: status === "fail"
				? "failed"
				: status === "blocked"
					? "is blocked"
					: "is untested";
	return {
		platform,
		status,
		detail: `${platform} clean-folder install ${action} at ${report.generatedAt ?? "an unknown time"}.`,
		report: relative(root, reportPath),
	};
}

function platformMatrix({ root, packageRoot, version, packageGeneratedAt } = {}) {
	return [
		platformValidationEntry({
			root,
			packageRoot,
			platform: "macOS",
			reportFile: `macos-clean-install-validation-${version ?? "unknown"}.json`,
			version,
			packageGeneratedAt,
			defaultDetail: "Clean-folder installer validation requires explicit approval before running.",
		}),
		platformValidationEntry({
			root,
			packageRoot,
			platform: "Windows",
			reportFile: `windows-clean-install-validation-${version ?? "unknown"}.json`,
			version,
			packageGeneratedAt,
			defaultDetail: "PowerShell installer validation needs a real Windows machine or VM.",
		}),
		platformValidationEntry({
			root,
			packageRoot,
			platform: "Linux",
			reportFile: `linux-clean-install-validation-${version ?? "unknown"}.json`,
			version,
			packageGeneratedAt,
			defaultDetail: "Shell installer validation needs a clean Linux user account or VM.",
		}),
	];
}

function statusFromChecks(checks, platforms) {
	if (checks.some((check) => check.status === "FAIL")) {
		return "blocked";
	}

	if (platforms.every((platform) => platform.status === "pass")) {
		return "ready";
	}

	return "watch";
}

function notReadyReasons(checks, platforms) {
	const reasons = [];
	for (const check of checks) {
		if (check.status === "FAIL") {
			reasons.push(`${check.label}: ${check.detail}`);
		}
	}

	for (const platform of platforms) {
		if (platform.status !== "pass") {
			reasons.push(`${platform.platform} validation is ${platform.status}.`);
		}
	}

	return reasons;
}

export function verifyFriendPackage(options = {}) {
	const root = options.root ?? process.cwd();
	const packageRoot = options.packageRoot ?? join(root, "dist", "friend-package");
	const latestPath = options.latestPath ?? join(packageRoot, "latest.json");
	const checks = [];

	if (!existsSync(latestPath)) {
		checks.push(
			makeCheck(
				"FAIL",
				"Release index",
				missingFriendPackageLatestMessage(FRIEND_PACKAGE_LATEST_REL),
			),
		);
		const platforms = platformMatrix({ root, packageRoot });
		const generatedAt = new Date().toISOString();
		const report = {
			schemaVersion: 1,
			generatedAt,
			status: "blocked",
			safeToShare: false,
			blockers: notReadyReasons(checks, platforms),
			warnings: [],
			summary: {
				version: "unknown",
				channel: "friends",
				archiveCount: 0,
				totalArchiveBytes: 0,
				artifactCount: 0,
			},
			checks,
			platformMatrix: platforms,
			release: {
				updateChannels: UPDATE_CHANNELS,
				promotionChecklist: PROMOTION_CHECKLIST,
				runbookLinks: RUNBOOK_LINKS,
			},
			finalHumanChecklist: FINAL_HUMAN_CHECKLIST,
		};
		return {
			status: "blocked",
			safeToShare: false,
			checks,
			report,
			reportPath: join(packageRoot, "validation-report.json"),
		};
	}

	const latest = readJson(latestPath);
	if (latest.__error) {
		checks.push(
			makeCheck("FAIL", "Release index", `Could not parse latest.json: ${latest.__error}`),
		);
	}

	const currentManifestPath = join(
		root,
		latest.manifest?.file ?? "dist/release/zaraa-friend-release-manifest.json",
	);
	let currentManifest = null;
	if (existsSync(currentManifestPath)) {
		currentManifest = readJson(currentManifestPath);
		if (currentManifest.__error) {
			checks.push(
				makeCheck(
					"FAIL",
					"Release manifest",
					`Could not parse current release manifest: ${currentManifest.__error}`,
				),
			);
		} else if (
			currentManifest.version &&
			latest.version &&
			currentManifest.version !== latest.version
		) {
			checks.push(
				makeCheck(
					"FAIL",
					"Manifest/package version",
					`latest.json is ${latest.version}, but current release manifest is ${currentManifest.version}. Regenerate with pnpm ship:package.`,
				),
			);
		} else {
			checks.push(
				makeCheck(
					"PASS",
					"Manifest/package version",
					`${latest.version ?? "unknown"} matches current manifest.`,
				),
			);
		}
	} else {
		checks.push(
			makeCheck(
				"WARN",
				"Release manifest",
				"Current release manifest was not found while verifying the package.",
			),
		);
	}

	// Two mutually stale files can agree with each other; require identity with source package.json too.
	const rootPackagePath = join(root, "package.json");
	if (existsSync(rootPackagePath)) {
		const rootPackage = readJson(rootPackagePath);
		const rootVersion = typeof rootPackage.version === "string" ? rootPackage.version : null;
		if (rootPackage.__error) {
			checks.push(
				makeCheck(
					"FAIL",
					"Source package version",
					`Could not parse package.json: ${rootPackage.__error}`,
				),
			);
		} else if (!rootVersion) {
			checks.push(
				makeCheck("FAIL", "Source package version", "Root package.json has no version field."),
			);
		} else if (latest.version && latest.version !== rootVersion) {
			checks.push(
				makeCheck(
					"FAIL",
					"Source package version",
					`latest.json is ${latest.version}, but source package.json is ${rootVersion}. Do not treat the old archive as proof for current dirty source; regenerate after P0/P1 fixes.`,
				),
			);
		} else {
			checks.push(
				makeCheck("PASS", "Source package version", `${rootVersion} matches latest.json.`),
			);
		}
	} else {
		checks.push(
			makeCheck(
				"WARN",
				"Source package version",
				"Root package.json was not found while verifying the package.",
			),
		);
	}

	const packageDirectory = latest.package?.directory;
	const stageDir = packageDirectory ? join(packageRoot, packageDirectory) : null;
	const sourceIdentityIssues = [];
	const currentRevision = releaseManifestRevision(currentManifest);
	const stagedManifestPath = stageDir
		? join(stageDir, "dist", "release", "zaraa-friend-release-manifest.json")
		: null;
	const stagedManifest =
		stagedManifestPath && existsSync(stagedManifestPath) ? readJson(stagedManifestPath) : null;
	const stagedRevision = releaseManifestRevision(stagedManifest);
	if (currentManifest && !currentRevision) {
		sourceIdentityIssues.push("current release manifest lacks schema-2 clean Git identity");
	}
	if (!stagedRevision) {
		sourceIdentityIssues.push("staged release manifest lacks schema-2 clean Git identity");
	}
	if (currentRevision && stagedRevision && currentRevision !== stagedRevision) {
		sourceIdentityIssues.push(
			`current manifest revision ${currentRevision} differs from staged revision ${stagedRevision}`,
		);
	}
	try {
		const source = inspectFriendReleaseSource(root);
		if (stagedRevision && source.revision !== stagedRevision) {
			sourceIdentityIssues.push(
				`source HEAD ${source.revision} differs from staged manifest revision ${stagedRevision}`,
			);
		}
		if (currentRevision && source.revision !== currentRevision) {
			sourceIdentityIssues.push(
				`source HEAD ${source.revision} differs from current manifest revision ${currentRevision}`,
			);
		}
	} catch (error) {
		sourceIdentityIssues.push(error instanceof Error ? error.message : String(error));
	}
	const mirrorPath = join(root, ".mirror-provenance.json");
	const mirrorIdentity = matchesMirrorIdentity({
		issues: sourceIdentityIssues,
		marker: existsSync(mirrorPath) ? readJson(mirrorPath) : null,
		stagedRevision, currentRevision, latest,
		manifestSha256: stagedManifestPath && existsSync(stagedManifestPath)
			? createHash("sha256").update(readFileSync(stagedManifestPath)).digest("hex") : null,
	});
	checks.push(
		sourceIdentityIssues.length > 0
			? mirrorIdentity
				? makeCheck("WARN", "Release source identity", `Pinned mirror of ${stagedRevision}; package date and staged manifest SHA256 match. This validates the recorded artifact, not current canonical source.`)
				: makeCheck("FAIL", "Release source identity", sourceIdentityIssues.join("; "))
			: makeCheck(
					"PASS",
					"Release source identity",
					`${stagedRevision} matches staged manifest and clean source HEAD${currentRevision ? " and current manifest" : ""}.`,
				),
	);
	if (stageDir && existsSync(stageDir)) {
		checks.push(makeCheck("PASS", "Staged package", relative(root, stageDir)));
		const unsafePaths = findUnsafeStagedPaths(stageDir);
		checks.push(
			unsafePaths.length === 0
				? makeCheck(
						"PASS",
						"Staged package path hygiene",
						"No forbidden path names (local state, logs, secrets-named paths, tests, experiment output, packages/<pkg>/src).",
					)
				: makeCheck(
						"FAIL",
						"Staged package path hygiene",
						`${unsafePaths.length} unsafe path(s): ${unsafePaths.slice(0, 5).join(", ")}${unsafePaths.length > 5 ? ", ..." : ""}`,
					),
		);
		const contentScan = scanStagedPackageContent(stageDir);
		const incompleteScan =
			contentScan.scanErrors.length > 0 || contentScan.oversizeFiles.length > 0;
		const incompleteDetail = incompleteScan ? incompleteContentScanDetail(contentScan) : "";
		// Empty text surface means the walk never covered ship code (wrong stage, all-binary, or skip bug).
		if (contentScan.scannedFiles === 0 && !incompleteScan) {
			checks.push(
				makeCheck(
					"FAIL",
					"Staged package content secret scan",
					"Scanned 0 ship-surface text files — refuse empty content scan (stage layout or filter bug).",
				),
			);
			checks.push(
				makeCheck(
					"FAIL",
					"Staged package owner-path scan",
					"Scanned 0 ship-surface text files — refuse empty owner-path scan.",
				),
			);
		} else if (contentScan.secretFindings.length > 0) {
			const sample = contentScan.secretFindings
				.slice(0, 5)
				.map((f) => `${f.file}:${f.line} (${f.kind} ${f.masked})`)
				.join("; ");
			checks.push(
				makeCheck(
					"FAIL",
					"Staged package content secret scan",
					`${contentScan.secretFindings.length} finding(s) in ${contentScan.scannedFiles} file(s): ${sample}${contentScan.secretFindings.length > 5 ? "; ..." : ""}${incompleteScan ? ` | incomplete: ${incompleteDetail}` : ""}`,
				),
			);
		} else if (incompleteScan) {
			// Positive scannedFiles alone is not coverage proof when paths were skipped/unreadable.
			checks.push(
				makeCheck(
					"FAIL",
					"Staged package content secret scan",
					`Incomplete content scan after ${contentScan.scannedFiles} file(s): ${incompleteDetail}`,
				),
			);
		} else {
			checks.push(
				makeCheck(
					"PASS",
					"Staged package content secret scan",
					`Scanned ${contentScan.scannedFiles} ship-surface file(s); no secret-shaped content found.`,
				),
			);
		}
		if (contentScan.ownerPathFindings.length > 0) {
			const sample = contentScan.ownerPathFindings
				.slice(0, 5)
				.map((f) => `${f.file} (${f.kinds.join(",")})`)
				.join("; ");
			checks.push(
				makeCheck(
					"FAIL",
					"Staged package owner-path scan",
					`${contentScan.ownerPathFindings.length} file(s) contain owner path residue — rebuild core/cli dist and repackage: ${sample}${contentScan.ownerPathFindings.length > 5 ? "; ..." : ""}${incompleteScan ? ` | incomplete: ${incompleteDetail}` : ""}`,
				),
			);
		} else if (contentScan.scannedFiles === 0 && !incompleteScan) {
			// already failed above as empty
		} else if (incompleteScan) {
			checks.push(
				makeCheck(
					"FAIL",
					"Staged package owner-path scan",
					`Incomplete owner-path scan after ${contentScan.scannedFiles} file(s): ${incompleteDetail}`,
				),
			);
		} else {
			checks.push(
				makeCheck(
					"PASS",
					"Staged package owner-path scan",
					`Scanned ${contentScan.scannedFiles} ship-surface file(s); no owner home, affiliate repo, or owner Amazon tag residue.`,
				),
			);
		}
	} else {
		checks.push(
			makeCheck("FAIL", "Staged package", "Package directory from latest.json is missing."),
		);
	}

	if (stageDir) {
		for (const [label, relPath] of REQUIRED_INSTALLERS) {
			checks.push(requiredStagedFileCheck(stageDir, label, relPath));
		}

		for (const [label, relPath] of REQUIRED_DOCS) {
			checks.push(requiredStagedFileCheck(stageDir, label, relPath));
		}

		for (const [label, relPath] of REQUIRED_RUNTIME) {
			checks.push(requiredStagedFileCheck(stageDir, label, relPath));
		}
	}

	const archives = Array.isArray(latest.package?.archives) ? latest.package.archives : [];
	if (archives.length === 0) {
		checks.push(
			makeCheck("FAIL", "Package archives", "latest.json does not list any archive files."),
		);
	}

	let totalArchiveBytes = 0;
	for (const archive of archives) {
		const archivePath = join(packageRoot, archive.file ?? "");
		if (!archive.file || !existsSync(archivePath)) {
			checks.push(
				makeCheck(
					"FAIL",
					"Archive file",
					`${archive.file ?? "(missing file name)"} does not exist.`,
				),
			);
			continue;
		}

		const actualBytes = fileSize(archivePath);
		totalArchiveBytes += actualBytes;
		checks.push(
			actualBytes === archive.bytes
				? makeCheck("PASS", "Archive size", `${archive.file} is ${actualBytes} bytes.`)
				: makeCheck(
						"FAIL",
						"Archive size",
						`${archive.file} expected ${archive.bytes} bytes, found ${actualBytes}.`,
					),
		);

		const actualHash = sha256(archivePath);
		checks.push(
			actualHash === archive.sha256
				? makeCheck("PASS", "Archive SHA256", `${archive.file} hash matches latest.json.`)
				: makeCheck("FAIL", "Archive SHA256", `${archive.file} hash mismatch.`),
		);

		if (!stageDir || !existsSync(stageDir)) {
			checks.push(
				makeCheck(
					"FAIL",
					"Archive/staged package contents",
					`${archive.file} cannot be compared because the staged package is missing.`,
				),
			);
			continue;
		}
		try {
			const comparison = compareArchiveToStage(stageDir, archivePath, packageDirectory, mirrorIdentity);
			checks.push(
				comparison.differences.length === 0
					? makeCheck(
							"PASS",
							"Archive/staged package contents",
							`${archive.file} matches ${comparison.entryCount} staged package entries.`,
						)
					: makeCheck(
							"FAIL",
							"Archive/staged package contents",
							`${archive.file} differs from the staged package: ${comparison.differences.slice(0, 5).join("; ")}${comparison.differences.length > 5 ? "; ..." : ""}`,
						),
			);
		} catch (error) {
			checks.push(
				makeCheck(
					"FAIL",
					"Archive/staged package contents",
					`${archive.file} could not be inventoried safely: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
	}

	const artifactCount = Number(latest.manifest?.artifacts ?? 0);
	checks.push(
		artifactCount > 0
			? makeCheck(
					"PASS",
					"Release artifact count",
					`${artifactCount} artifact(s) recorded in release manifest.`,
				)
			: makeCheck("WARN", "Release artifact count", "No release artifact count was recorded."),
	);
	checks.push(
		totalArchiveBytes > 0
			? makeCheck("PASS", "Package archive bytes", `${totalArchiveBytes} total archive bytes.`)
			: makeCheck("WARN", "Package archive bytes", "No archive bytes could be counted."),
	);

	const platforms = platformMatrix({
		root,
		packageRoot: options.evidenceRoot ?? packageRoot,
		version: latest.version,
		packageGeneratedAt: latest.generatedAt,
	});
	const status = statusFromChecks(checks, platforms);
	const blockers = notReadyReasons(checks, platforms);
	const warnings = checks
		.filter((check) => check.status === "WARN")
		.map((check) => `${check.label}: ${check.detail}`);
	const generatedAt = new Date().toISOString();
	const safeToShare = status === "ready";
	const reportPath = join(packageRoot, "validation-report.json");
	const publicReleaseDir = join(root, "packages", "web", "public", "release");
	const updatedLatest = {
		...latest,
		package: {
			...latest.package,
			totalArchiveBytes,
			contents: {
				installers: REQUIRED_INSTALLERS.map(([, path]) => path),
				docs: REQUIRED_DOCS.map(([, path]) => path),
			},
		},
		docs: {
			installGuide: "docs/friend-harness-install-guide.md",
			handoffReadme: "docs/friend-package-handoff.md",
			releaseNotesTemplate: "docs/friend-release-notes-template.md",
			knownIssues: "docs/friend-known-issues.md",
			platformValidation: "docs/friend-platform-validation.md",
			platformValidationHandoff: "docs/friend-platform-validation-handoff.md",
		},
		release: {
			updateChannels: UPDATE_CHANNELS,
			promotionChecklist: PROMOTION_CHECKLIST,
			runbookLinks: RUNBOOK_LINKS,
			finalHumanChecklist: FINAL_HUMAN_CHECKLIST,
			knownIssues:
				platforms.filter((platform) => platform.status !== "pass").length > 0
					? platforms
							.filter((platform) => platform.status !== "pass")
							.map((platform) => `${platform.platform} installer validation is ${platform.status}.`)
					: ["All platform validation gates are passing."],
			releaseNotesTemplate: "docs/friend-release-notes-template.md",
		},
		validation: {
			report: "dist/friend-package/validation-report.json",
			status,
			safeToShare,
			lastVerifiedAt: generatedAt,
			blockers,
			warnings,
		},
	};
	const report = {
		schemaVersion: 1,
		generatedAt,
		status,
		safeToShare,
		blockers,
		warnings,
		summary: {
			version: latest.version ?? "unknown",
			channel: latest.channel ?? "friends",
			packageDirectory: packageDirectory ?? null,
			archiveCount: archives.length,
			totalArchiveBytes,
			artifactCount,
			validationReport: "dist/friend-package/validation-report.json",
		},
		checks,
		packageContents: updatedLatest.package.contents,
		platformMatrix: platforms,
		release: updatedLatest.release,
		finalHumanChecklist: FINAL_HUMAN_CHECKLIST,
	};

	if (options.writeReport !== false) {
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		writeFileSync(latestPath, `${JSON.stringify(updatedLatest, null, 2)}\n`);
		// The handoff doc is the copy a platform tester actually reads, and it is
		// generated from this report. `ship:candidate` emits it *before* any
		// validation runs, so without this it is guaranteed to be stale: it kept
		// claiming macOS/Linux "blocked" after both had passed. A tester acting on
		// a stale matrix wastes the one validation that cannot be self-served.
		// Refresh it wherever the report is rewritten. Best-effort: a doc-sync
		// failure must never fail verification itself.
		try {
			syncPlatformValidationHandoff({ root, log: false });
		} catch {}
	}

	if (options.syncPublic !== false) {
		mkdirSync(publicReleaseDir, { recursive: true });
		writeFileSync(
			join(publicReleaseDir, "latest.json"),
			`${JSON.stringify(updatedLatest, null, 2)}\n`,
		);
		writeFileSync(
			join(publicReleaseDir, "validation-report.json"),
			`${JSON.stringify(report, null, 2)}\n`,
		);
	}

	return { status, safeToShare, checks, report, reportPath, latest: updatedLatest };
}

function printResult(result) {
	console.log("\nZaraa friend-package verification\n");
	for (const check of result.checks) {
		const line = `${check.status.padEnd(4)}  ${check.label}`;
		console.log(check.detail ? `${line} - ${check.detail}` : line);
	}
	console.log("");
	console.log(`Status: ${result.status}`);
	console.log(`Safe to share: ${result.safeToShare ? "yes" : "no"}`);
	console.log(`Validation report: ${relative(process.cwd(), result.reportPath)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const mirror = existsSync(join(process.cwd(), ".mirror-provenance.json"));
	const evidenceRoot = join(process.cwd(), ".validation");
	const result = verifyFriendPackage(mirror ? { evidenceRoot, writeReport: false, syncPublic: false } : {});
	if (mirror) {
		mkdirSync(evidenceRoot, { recursive: true });
		result.reportPath = join(evidenceRoot, "validation-report.json");
		writeFileSync(result.reportPath, `${JSON.stringify(result.report, null, 2)}\n`);
	}
	printResult(result);
	if (!result.safeToShare) {
		process.exitCode = 1;
	}
}
