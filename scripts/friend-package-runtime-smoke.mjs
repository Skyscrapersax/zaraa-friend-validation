import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

const ROUTES = ["/ship-readiness", "/cockpit", "/dashboard", "/brain-map"];

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

async function stopChild(child, exitPromise) {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([exitPromise, sleep(5_000)]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await Promise.race([exitPromise, sleep(2_000)]);
	}
}

async function fetchWithTimeout(url, timeoutMs = 1_500) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

export async function runFriendRuntimeSmoke({ installDir, tempBase, env, timeoutMs = 60_000 }) {
	const port = await reservePort();
	const daemonPath = path.join(installDir, "scripts", "zaraa-daemon.mjs");
	const runtimeLogPath = path.join(tempBase, "runtime-output.log");
	const child = spawn(process.execPath, [daemonPath], {
		cwd: installDir,
		env: {
			...env,
			ZARAA_GATEWAY_PORT: String(port),
			ZARAA_DISABLE_IMESSAGE: "1",
			ZARAA_DATA_DIR: path.join(tempBase, "runtime-data"),
			ZARAA_DAEMON_LOCK_DIR: path.join(tempBase, "runtime-lock"),
			ZARAA_SERVICE_LABEL: "com.zaraa.friend-validation",
			ZARAA_RESTART_LOG: path.join(tempBase, "runtime-restart-log.json"),
			ZARAA_RESTART_INTENT_LOG: path.join(tempBase, "runtime-restart-intents.jsonl"),
			ZARAA_DAEMON_HEARTBEAT_INTERVAL_MS: "60000",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	let output = "";
	const append = (chunk) => {
		output = `${output}${chunk.toString()}`.slice(-200_000);
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	const exitPromise = new Promise((resolve) => {
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});

	let ready = false;
	const checks = [];
	try {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && child.exitCode === null) {
			try {
				const response = await fetchWithTimeout(`http://127.0.0.1:${port}/ready`);
				if (response.ok && (await response.json()).status === "ready") {
					ready = true;
					break;
				}
			} catch {
				// Startup still in progress.
			}
			await sleep(250);
		}

		if (ready) {
			for (const route of ROUTES) {
				try {
					const response = await fetchWithTimeout(`http://127.0.0.1:${port}${route}`);
					const cacheControl = response.headers.get("cache-control") ?? "";
					checks.push({
						route,
						status: response.ok && cacheControl.includes("no-store") ? "pass" : "fail",
						detail: `HTTP ${response.status}; Cache-Control: ${cacheControl || "missing"}`,
					});
				} catch (error) {
					checks.push({
						route,
						status: "fail",
						detail: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	} finally {
		await stopChild(child, exitPromise);
		await writeFile(runtimeLogPath, output);
	}

	const routesPassed =
		checks.length === ROUTES.length && checks.every((check) => check.status === "pass");
	return {
		status: ready && routesPassed ? "pass" : "fail",
		ready,
		routesPassed,
		checks,
		exitCode: child.exitCode,
		logPath: runtimeLogPath,
		logTail: output.split(/\r?\n/).slice(-30).filter(Boolean),
	};
}
