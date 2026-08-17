import {
  loadGatewayApiKey
} from "./chunk-5Q7ELQ3Z.js";
import {
  resolveRuntimeHomeDir
} from "./chunk-DI2OPTT7.js";

// src/commands/gateway-diagnostics.ts
import { execFile } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
var execFileAsync = promisify(execFile);
function readDaemonOwnerPid() {
  try {
    const ownerPath = join(
      resolveRuntimeHomeDir(),
      ".zaraa",
      "locks",
      "zaraa-daemon.lock",
      "owner.json"
    );
    if (!existsSync(ownerPath)) return null;
    const owner = JSON.parse(readFileSync(ownerPath, "utf-8"));
    return Number.isInteger(owner.pid) && Number(owner.pid) > 0 ? Number(owner.pid) : null;
  } catch {
    return null;
  }
}
async function collectGatewayAccessSnapshot(port) {
  let daemonDetected = readDaemonOwnerPid() !== null;
  try {
    const { stdout } = await execFileAsync("ps", ["ax", "-o", "command="]);
    const hasDaemonProcess = stdout.split("\n").map((line) => line.trim()).filter(Boolean).some((line) => line.includes("scripts/zaraa-daemon.mjs"));
    daemonDetected = daemonDetected || hasDaemonProcess;
  } catch {
  }
  let gatewayListenerCount = 0;
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
    gatewayListenerCount = stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(1).length;
  } catch {
  }
  return {
    hasApiKey: Boolean(loadGatewayApiKey()),
    daemonDetected,
    gatewayListenerCount
  };
}
function buildGatewayAccessFailureMessage(subject, port, snapshot, results) {
  if (results.some((result) => result.status === 401)) {
    return `${subject} The gateway rejected the API key (HTTP 401). Check gateway.auth.apiKey in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY.`;
  }
  if (!snapshot.hasApiKey) {
    return `${subject} No local gateway API key was found in ~/.zaraa/zaraa.config.json or ZARAA_API_KEY.`;
  }
  if (!snapshot.daemonDetected) {
    return `${subject} No zaraa-daemon process was detected. Start or restart the daemon first.`;
  }
  if (snapshot.gatewayListenerCount === 0) {
    return `${subject} A zaraa-daemon process exists, but nothing is listening on port ${port}.`;
  }
  return `${subject} A local listener exists on port ${port} and a gateway API key is present, so this usually points to a local networking or sandbox boundary rather than a missing daemon.`;
}
function buildGatewayEndpointFailureMessage(subject, endpoint, port, snapshot, results) {
  if (results.some((result) => result.status === 404)) {
    return `${subject} ${endpoint} returned HTTP 404. This gateway may be running an older build or that endpoint is not enabled.`;
  }
  return buildGatewayAccessFailureMessage(subject, port, snapshot, results);
}

export {
  collectGatewayAccessSnapshot,
  buildGatewayAccessFailureMessage,
  buildGatewayEndpointFailureMessage
};
