#!/usr/bin/env node

import {
	MANIFEST_PATH,
	MARKDOWN_PATH,
	generateOvernightManifest,
	writeOvernightManifest,
} from "./overnight-operator-lib.mjs";

function main() {
	const { manifest } = generateOvernightManifest();
	writeOvernightManifest(manifest);

	console.log(`Generated adaptive overnight operator pack with ${manifest.metadata.totalTasks} tasks.`);
	console.log(`JSON: ${MANIFEST_PATH}`);
	console.log(`Markdown: ${MARKDOWN_PATH}`);
	if (manifest.metadata.historyError) {
		console.log(`History note: ${manifest.metadata.historyError}`);
	}
}

main();
