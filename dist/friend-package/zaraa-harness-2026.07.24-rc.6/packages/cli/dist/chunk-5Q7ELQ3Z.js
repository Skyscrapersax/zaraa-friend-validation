import {
  resolveCliConfigDir
} from "./chunk-DI2OPTT7.js";

// src/commands/gateway-client.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
function asApiKey(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function getLocalConfigCandidates() {
  const configDir = resolveCliConfigDir();
  return [
    process.env.ZARA_CONFIG_PATH ?? null,
    join(configDir, "zaraa.config.json"),
    join(configDir, "config.json")
  ].filter(Boolean);
}
function loadLocalZaraaConfig() {
  for (const path of getLocalConfigCandidates()) {
    if (!existsSync(path)) continue;
    try {
      return {
        path,
        data: JSON.parse(readFileSync(path, "utf-8"))
      };
    } catch {
    }
  }
  return { path: null, data: null };
}
function loadGatewayApiKey() {
  const config = loadLocalZaraaConfig();
  if (config.data) {
    return asApiKey(config.data.gateway?.auth?.apiKey) ?? asApiKey(config.data.apiKey) ?? process.env.ZARAA_API_KEY ?? null;
  }
  return process.env.ZARAA_API_KEY ?? null;
}
function getGatewayBaseUrls(port) {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}
function summarizeTransportErrors(errors) {
  if (errors.length === 0) return "unknown error";
  const messages = [...new Set(errors.map(({ message }) => message.trim()).filter(Boolean))];
  if (messages.length === 1) {
    return `Local loopback requests failed from this environment: ${messages[0]}`;
  }
  return errors.map(({ baseUrl, message }) => `${baseUrl}: ${message}`).join(" | ");
}
function buildGatewayHeaders(options) {
  const headers = { ...options.headers ?? {} };
  const apiKey = options.apiKey ?? loadGatewayApiKey();
  if (apiKey && !headers["X-Api-Key"]) headers["X-Api-Key"] = apiKey;
  if (options.body !== void 0 && !headers["Content-Type"])
    headers["Content-Type"] = "application/json";
  return headers;
}
function getRequestSignal(options) {
  if (options.signal) return options.signal;
  if (options.timeoutMs === null || options.timeoutMs === 0) return void 0;
  return AbortSignal.timeout(options.timeoutMs ?? 15e3);
}
async function fetchGatewayResponse(port, path, options = {}) {
  const headers = buildGatewayHeaders(options);
  const signal = getRequestSignal(options);
  const errors = [];
  for (const baseUrl of getGatewayBaseUrls(port)) {
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body !== void 0 ? JSON.stringify(options.body) : void 0,
        signal
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ baseUrl, message });
    }
  }
  throw new Error(summarizeTransportErrors(errors));
}
async function requestGatewayJson(port, path, options = {}) {
  try {
    const response = await fetchGatewayResponse(port, path, options);
    const text = await response.text();
    let data = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: response.status,
          data: null,
          error: `Invalid JSON from ${path}`
        };
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export {
  getLocalConfigCandidates,
  loadLocalZaraaConfig,
  loadGatewayApiKey,
  getGatewayBaseUrls,
  fetchGatewayResponse,
  requestGatewayJson
};
