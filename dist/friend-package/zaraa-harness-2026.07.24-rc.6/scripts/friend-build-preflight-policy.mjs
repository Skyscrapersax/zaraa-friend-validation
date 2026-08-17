export function summarizeFriendPackageVerification(result, { requirePackage = false } = {}) {
	const hasFailures = result.checks.some((check) => check.status === "FAIL");
	const isUnsafe = result.status !== "ready" || result.safeToShare !== true;
	const detail = `${result.status}; report written to ${result.report.summary.validationReport}; safe to share: ${
		result.safeToShare ? "yes" : "no"
	}.`;

	if (hasFailures || isUnsafe) {
		const blockers = Array.isArray(result.report.blockers) ? result.report.blockers : [];
		const next = blockers.length > 0
			? ` Blockers: ${blockers.join(" ")}`
			: " Complete package validation before sharing.";
		return {
			status: requirePackage ? "FAIL" : "WARN",
			detail: `${detail}${next}`,
		};
	}

	return {
		status: "PASS",
		detail,
	};
}

export function summarize24hProof(summary, source, { currentRuntimeIdentity } = {}) {
	const blockers = [];
	if (summary?.complete !== true) blockers.push("incomplete");
	if (summary?.badCount !== 0) blockers.push(`badCount=${String(summary?.badCount)}`);
	if (summary?.continuityBreakCount !== 0) {
		blockers.push(`continuityBreakCount=${String(summary?.continuityBreakCount)}`);
	}
	const proofRuntimeSha = summary?.runtimeIdentity?.sha256;
	const currentRuntimeSha = currentRuntimeIdentity?.sha256;
	if (!proofRuntimeSha) blockers.push("runtime identity missing");
	if (!currentRuntimeSha) blockers.push("current runtime identity missing");
	else if (proofRuntimeSha && proofRuntimeSha !== currentRuntimeSha) {
		blockers.push("runtime artifacts changed");
	}
	const proofPlatform = [
		summary?.runtimeIdentity?.platform,
		summary?.runtimeIdentity?.architecture,
		summary?.runtimeIdentity?.nodeAbi,
	];
	const currentPlatform = [
		currentRuntimeIdentity?.platform,
		currentRuntimeIdentity?.architecture,
		currentRuntimeIdentity?.nodeAbi,
	];
	if (proofPlatform.some((value) => !value)) blockers.push("runtime platform identity missing");
	if (currentPlatform.some((value) => !value)) blockers.push("current runtime platform identity missing");
	else if (proofPlatform.every(Boolean) && proofPlatform.some((value, i) => value !== currentPlatform[i])) {
		blockers.push("runtime platform changed");
	}
	const proofConfigRevision = summary?.runtimeIdentity?.configRevision?.revision;
	const currentConfigRevision = currentRuntimeIdentity?.configRevision?.revision;
	if (!proofConfigRevision) blockers.push("runtime config revision missing");
	if (!currentConfigRevision) blockers.push("current runtime config revision missing");
	else if (proofConfigRevision && proofConfigRevision !== currentConfigRevision) {
		blockers.push("runtime config changed");
	}
	const proofConfigPath = summary?.runtimeIdentity?.configRevision?.path;
	const currentConfigPath = currentRuntimeIdentity?.configRevision?.path;
	if (!proofConfigPath) blockers.push("runtime config path missing");
	if (!currentConfigPath) blockers.push("current runtime config path missing");
	else if (proofConfigPath && proofConfigPath !== currentConfigPath) {
		blockers.push("runtime config path changed");
	}

	return blockers.length === 0
		? {
				status: "PASS",
				detail: `${source} is complete with no bad samples or continuity breaks; runtime ${proofRuntimeSha.slice(0, 12)} matches.`,
			}
		: { status: "FAIL", detail: `${source} is not ship-ready: ${blockers.join(", ")}.` };
}
