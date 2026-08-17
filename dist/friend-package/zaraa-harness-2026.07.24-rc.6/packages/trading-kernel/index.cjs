"use strict";

const candidates = [
	"./trading_kernel.node",
	"./trading-kernel.node",
	"./index.node",
	"./trading_kernel.darwin-arm64.node",
	"./trading_kernel.darwin-x64.node",
	"./trading_kernel.linux-x64-gnu.node",
	"./trading_kernel.linux-x64-musl.node",
	"./trading_kernel.linux-arm64-gnu.node",
	"./trading_kernel.linux-arm64-musl.node",
	"./trading_kernel.win32-x64-msvc.node",
	"./trading_kernel.win32-arm64-msvc.node"
];

function loadNative() {
	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch {
			// Absent native binding is acceptable; callers keep deterministic TS fallback.
		}
	}

	return null;
}

const native = loadNative();

function unavailable() {
	return JSON.stringify({
		ok: false,
		backend: "native-unavailable",
		error: {
			code: "native_unavailable",
			message: "trading_kernel native binding is not built for this platform"
		}
	});
}

function scoreRouteBatchJson(rawJson) {
	if (native && typeof native.scoreRouteBatchJson === "function") {
		return native.scoreRouteBatchJson(rawJson);
	}

	return unavailable();
}

function tradingKernelBackend() {
	if (native && typeof native.tradingKernelBackend === "function") {
		return native.tradingKernelBackend();
	}

	return "native-unavailable";
}

module.exports = {
	scoreRouteBatchJson,
	tradingKernelBackend
};
