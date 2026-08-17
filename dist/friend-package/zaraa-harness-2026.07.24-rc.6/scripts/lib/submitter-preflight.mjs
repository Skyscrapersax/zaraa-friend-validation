const DEFAULT_GATEWAY_BASE = "http://127.0.0.1:3927";

function normalizeBase(value) {
	return String(value || DEFAULT_GATEWAY_BASE).replace(/\/+$/, "");
}

function gatewayHeaders(apiKey) {
	return apiKey ? { "X-Api-Key": apiKey } : {};
}

async function readResponse(response) {
	const text = await response.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = null;
	}
	return { body, text };
}

function formatReason(body, text, status) {
	return String(body?.error ?? body?.message ?? text ?? `HTTP ${status}`).slice(0, 240);
}

async function getTaskState({ gatewayBase, apiKey, fetchImpl, path, label }) {
	const response = await fetchImpl(`${normalizeBase(gatewayBase)}${path}`, {
		headers: gatewayHeaders(apiKey),
	});
	const { body, text } = await readResponse(response);
	if (!response.ok) {
		throw new Error(`${label} preflight failed (${response.status}): ${formatReason(body, text, response.status)}`);
	}
	return body ?? {};
}

export function shouldBlockForOperatorHold(generationState) {
	if (generationState?.paused === true && generationState?.operatorHold === true) {
		return {
			blocked: true,
			reason: generationState.reason || "operator-hold",
		};
	}
	return { blocked: false, reason: null };
}

export async function assertLiveSubmitPreflight({
	gatewayBase = DEFAULT_GATEWAY_BASE,
	apiKey = "",
	fetchImpl = globalThis.fetch,
} = {}) {
	if (typeof fetchImpl !== "function") {
		throw new Error("Submitter preflight requires fetch");
	}

	const generationState = await getTaskState({
		gatewayBase,
		apiKey,
		fetchImpl,
		path: "/api/tasks/generation",
		label: "Task generation",
	});
	const operatorHold = shouldBlockForOperatorHold(generationState);
	if (operatorHold.blocked) {
		throw new Error(
			`Refusing to submit novel growth tasks while operator hold is active: ${operatorHold.reason}`,
		);
	}
	if (generationState?.paused === true) {
		const reason = generationState.reason ? `: ${generationState.reason}` : "";
		throw new Error(`Task generation paused${reason}`);
	}

	const executionState = await getTaskState({
		gatewayBase,
		apiKey,
		fetchImpl,
		path: "/api/tasks/execution",
		label: "Task execution",
	});
	if (executionState?.paused === true) {
		const reason = executionState.reason ? `: ${executionState.reason}` : "";
		throw new Error(`Task execution paused${reason}`);
	}
}
