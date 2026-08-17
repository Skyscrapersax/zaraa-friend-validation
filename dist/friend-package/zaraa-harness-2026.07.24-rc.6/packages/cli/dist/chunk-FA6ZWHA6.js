import {
  buildGatewayAccessFailureMessage,
  collectGatewayAccessSnapshot
} from "./chunk-F4ZXZMER.js";
import {
  requestGatewayJson
} from "./chunk-5Q7ELQ3Z.js";

// src/commands/models.ts
function scopePath(scope, suffix) {
  const prefix = scope === "zaraacoder" ? "/api/zaraacoder/models" : "/api/models";
  return `${prefix}${suffix}`;
}
function printModelsUsage() {
  console.log("Usage:");
  console.log("  zaraa models list [--scope global|zaraacoder]");
  console.log("  zaraa models provider enable|disable <name> [--scope global|zaraacoder]");
  console.log("  zaraa models enable|disable <modelKey> [--scope global|zaraacoder]");
}
function parseScopeFlag(args) {
  const index = args.indexOf("--scope");
  if (index === -1) return "global";
  const value = args[index + 1]?.trim().toLowerCase();
  if (value === "zaraacoder" || value === "global") return value;
  return "global";
}
function stripScopeFlag(args) {
  const index = args.indexOf("--scope");
  if (index === -1) return args;
  const next = [...args.slice(0, index), ...args.slice(index + 2)];
  return next;
}
async function loadModelsDashboard(port, scope) {
  if (scope === "zaraacoder") {
    return requestGatewayJson(port, scopePath("zaraacoder", "/dashboard"));
  }
  const result = await requestGatewayJson(
    port,
    "/api/models/dashboard"
  );
  if (!result.ok) return result;
  return {
    ...result,
    data: {
      ...result.data,
      scope: "global",
      inheritGlobal: result.data?.availability?.inheritGlobal,
      primaryModel: result.data?.availability?.primaryModel ?? null,
      providers: result.data?.availability?.providers ?? []
    }
  };
}
async function runModelsCommand(port, args) {
  const positional = stripScopeFlag(args);
  const scope = parseScopeFlag(args);
  const action = positional[0];
  if (!action || action === "help" || action === "--help") {
    printModelsUsage();
    return 0;
  }
  if (action === "list") {
    const result = await loadModelsDashboard(port, scope);
    if (!result.ok) {
      console.error(`Failed to load model dashboard: ${result.error ?? "unknown error"}`);
      const snapshot = await collectGatewayAccessSnapshot(port);
      console.error(buildGatewayAccessFailureMessage("Model dashboard unavailable.", port, snapshot, [result]));
      return 1;
    }
    const providers = result.data?.providers ?? [];
    console.log(`Model pool (${scope})`);
    if (scope === "zaraacoder") {
      console.log(`Inherit global: ${result.data?.inheritGlobal !== false ? "yes" : "no"}`);
      console.log(`Primary model: ${result.data?.primaryModel ?? "(auto)"}`);
      console.log(`Planner fallback: ${result.data?.activeExecutorModel ?? "unknown"}`);
    }
    for (const provider of providers) {
      const enabled = scope === "zaraacoder" ? provider.zaraacoderEnabled : provider.globalEnabled;
      console.log(`- ${provider.name} (${provider.type}): ${enabled ? "on" : "off"}`);
      for (const model of provider.models) {
        const modelEnabled = scope === "zaraacoder" ? model.zaraacoderEnabled : model.globalEnabled;
        console.log(`    ${model.key}: ${modelEnabled ? "on" : "off"}`);
      }
    }
    return 0;
  }
  if (action === "provider") {
    const verb = positional[1];
    const name = positional[2];
    if (verb !== "enable" && verb !== "disable" || !name) {
      printModelsUsage();
      return 1;
    }
    const result = await requestGatewayJson(
      port,
      scopePath(scope, `/providers/${encodeURIComponent(name)}/${verb}`),
      { method: "POST" }
    );
    if (!result.ok) {
      console.error(`Failed to update provider: ${result.error ?? "unknown error"}`);
      return 1;
    }
    console.log(`Provider ${name} is now ${verb === "enable" ? "enabled" : "disabled"} (${scope}).`);
    return 0;
  }
  if (action === "enable" || action === "disable") {
    const modelKey = positional[1];
    if (!modelKey) {
      printModelsUsage();
      return 1;
    }
    const result = await requestGatewayJson(
      port,
      scopePath(scope, `/${encodeURIComponent(modelKey)}/${action}`),
      { method: "POST" }
    );
    if (!result.ok) {
      console.error(`Failed to update model: ${result.error ?? "unknown error"}`);
      return 1;
    }
    console.log(`Model ${modelKey} is now ${action === "enable" ? "enabled" : "disabled"} (${scope}).`);
    return 0;
  }
  printModelsUsage();
  return 1;
}
async function runZaraacoderModelsCommand(port, args) {
  const action = args[0];
  if (!action || action === "help" || action === "--help") {
    console.log("Usage:");
    console.log("  zaraa coder models status");
    console.log("  zaraa coder models pin <modelKey>|auto");
    return 0;
  }
  if (action === "status") {
    return runModelsCommand(port, ["list", "--scope", "zaraacoder"]);
  }
  if (action === "pin") {
    const modelKey = args[1];
    if (!modelKey) {
      console.error("Usage: zaraa coder models pin <modelKey>|auto");
      return 1;
    }
    const model = modelKey === "auto" ? null : modelKey;
    const result = await pinZaraacoderModel(port, model);
    if (!result.ok) {
      console.error(`Failed to pin model: ${result.data?.error ?? result.error ?? "unknown error"}`);
      return 1;
    }
    console.log(`Zaraacoder primary model: ${result.data?.primaryModel ?? "(auto)"}`);
    const dashboard = await loadModelsDashboard(port, "zaraacoder");
    if (dashboard.data?.executorRefresh !== "per-run") {
      console.log("Restart daemon before the next auto-agent run.");
    }
    return 0;
  }
  console.error("Usage: zaraa coder models status|pin");
  return 1;
}
function pinZaraacoderModel(port, model) {
  return requestGatewayJson(
    port,
    "/api/zaraacoder/models/primary",
    { method: "POST", body: { model } }
  );
}

export {
  loadModelsDashboard,
  runModelsCommand,
  runZaraacoderModelsCommand,
  pinZaraacoderModel
};
