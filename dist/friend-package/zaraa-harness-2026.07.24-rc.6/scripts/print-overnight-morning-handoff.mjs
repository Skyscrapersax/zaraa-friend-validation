#!/usr/bin/env node

import { buildMorningHandoffReport } from "./overnight-operator-lib.mjs";

function parseArgs(argv) {
	const options = {
		full: false,
		limit: 4,
	};

	for (const arg of argv) {
		if (arg === "--full") options.full = true;
		else if (arg.startsWith("--limit=")) options.limit = Number.parseInt(arg.split("=")[1] ?? "", 10);
	}

	return options;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const report = buildMorningHandoffReport(options);
	process.stdout.write(report);
}

main();
