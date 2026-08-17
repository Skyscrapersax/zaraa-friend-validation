import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { type ProxyOptions, defineConfig } from "vite";

const useHttps = process.env.VITE_HTTPS === "1";
const gatewayTarget = process.env.VITE_GATEWAY_TARGET || "http://localhost:3927";
const gatewayWsTarget =
	process.env.VITE_GATEWAY_WS_TARGET ||
	gatewayTarget.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

// Opt-in dev convenience: auto-auth read-only requests so a local browser can
// view the dashboard without logging in. OFF by default — the committed
// default always rides the gateway auth wall. Enable with ZARAA_DEV_AUTOAUTH=1
// ONLY on a loopback-only inspection server. Do NOT set it on a server reached
// through a tunnel: cloudflared proxies from loopback, so the socket check
// below cannot distinguish tunnel traffic, and the Host header is spoofable.
const devAutoAuth = process.env.ZARAA_DEV_AUTOAUTH === "1";

function isLoopbackSocket(req: IncomingMessage): boolean {
	const ip = req.socket.remoteAddress;
	return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

const apiProxy: ProxyOptions = devAutoAuth
	? {
			target: gatewayTarget,
			configure(proxy) {
				proxy.on("proxyReq", (proxyReq, req) => {
					if (!isLoopbackSocket(req) || req.method !== "GET") return;
					if (proxyReq.getHeader("x-api-key") || req.headers.cookie) return;
					try {
						const cfg = JSON.parse(
							readFileSync(join(homedir(), ".zaraa", "zaraa.config.json"), "utf8"),
						);
						const key = cfg?.gateway?.auth?.apiKey;
						if (typeof key === "string" && key) proxyReq.setHeader("X-Api-Key", key);
					} catch {
						// no local config — fall through to the normal auth wall
					}
				});
			},
		}
	: gatewayTarget;

export default defineConfig({
	plugins: [react(), tailwindcss(), ...(useHttps ? [basicSsl()] : [])],
	envDir: process.env.ZARAA_VITE_ENV_DIR ?? false,
	resolve: {
		alias: {
			"@zaraa/shared/designer-artifacts": fileURLToPath(
				new URL("../shared/src/designer-artifacts.ts", import.meta.url),
			),
		},
	},
	build: {
		rollupOptions: {
			output: {
				manualChunks(id) {
					const normalizedId = id.replaceAll("\\", "/");
					if (!id.includes("node_modules")) return;
					if (normalizedId.includes("@react-three/drei")) {
						return "drei-vendor";
					}
					if (normalizedId.includes("@react-three/fiber")) {
						return "fiber-vendor";
					}
					if (
						normalizedId.includes("three-stdlib") ||
						normalizedId.includes("camera-controls") ||
						normalizedId.includes("troika-three-text") ||
						normalizedId.includes("troika-three-utils") ||
						normalizedId.includes("troika-worker-utils") ||
						normalizedId.includes("/maath/") ||
						normalizedId.includes("meshline")
					) {
						return "three-helpers-vendor";
					}
					if (normalizedId.includes("/node_modules/three/src/renderers/")) {
						return "three-renderers-vendor";
					}
					if (
						normalizedId.includes("/node_modules/three/src/math/") ||
						normalizedId.includes("/node_modules/three/src/core/") ||
						normalizedId.includes("/node_modules/three/src/constants.js")
					) {
						return "three-foundation-vendor";
					}
					if (
						normalizedId.includes("/node_modules/three/src/animation/") ||
						normalizedId.includes("/node_modules/three/src/audio/") ||
						normalizedId.includes("/node_modules/three/src/extras/") ||
						normalizedId.includes("/node_modules/three/src/helpers/") ||
						normalizedId.includes("/node_modules/three/src/loaders/")
					) {
						return "three-runtime-vendor";
					}
					if (
						normalizedId.includes("/node_modules/three/src/nodes/") ||
						normalizedId.includes("/node_modules/three/src/utils.js") ||
						normalizedId.includes("/node_modules/three/src/Three.Core.js") ||
						normalizedId.includes("/node_modules/three/src/Three.js")
					) {
						return "three-engine-vendor";
					}
					if (
						normalizedId.includes("/node_modules/three/src/cameras/") ||
						normalizedId.includes("/node_modules/three/src/geometries/") ||
						normalizedId.includes("/node_modules/three/src/lights/") ||
						normalizedId.includes("/node_modules/three/src/materials/") ||
						normalizedId.includes("/node_modules/three/src/objects/") ||
						normalizedId.includes("/node_modules/three/src/scenes/") ||
						normalizedId.includes("/node_modules/three/src/textures/")
					) {
						return "three-scene-vendor";
					}
					if (normalizedId.includes("/node_modules/three/")) {
						return "three-core-vendor";
					}
					if (normalizedId.includes("recharts") || normalizedId.includes("d3-")) {
						return "charts-vendor";
					}
					if (normalizedId.includes("marked") || normalizedId.includes("dompurify")) {
						return "content-vendor";
					}
					if (normalizedId.includes("react") || normalizedId.includes("scheduler")) {
						return "react-vendor";
					}
				},
			},
		},
	},
	preview: {
		host: true,
		port: Number(process.env.PORT) || (useHttps ? 3929 : 3928),
	},
	server: {
		host: true,
		port: Number(process.env.PORT) || (useHttps ? 3929 : 3928),
		// Mobile preview through ephemeral trycloudflare tunnels (dev only).
		// /api rides the gateway auth wall unless ZARAA_DEV_AUTOAUTH=1 enables
		// the loopback-only read-auth convenience defined above.
		allowedHosts: [".trycloudflare.com"],
		proxy: {
			"/api": apiProxy,
			"/ws": { target: gatewayWsTarget, ws: true },
		},
	},
});
