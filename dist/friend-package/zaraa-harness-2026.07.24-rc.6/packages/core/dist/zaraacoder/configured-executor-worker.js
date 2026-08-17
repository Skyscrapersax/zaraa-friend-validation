import {
  createProviders,
  createZaraacoderExecutorAdapter,
  createZaraacoderModelPlanner,
  isZaraacoderBlockingError,
  zaraacoderIsolatedExecutorProtocol
} from "../chunk-KGZCB7XG.js";
import {
  findProviderForModelKey,
  isModelEnabled
} from "../chunk-UXKN3EGC.js";
import "../chunk-RSXICYJP.js";
import "../chunk-VMDTKFKO.js";
import "../chunk-H6G63P2E.js";
import "../chunk-R5U7XKVJ.js";

// src/zaraacoder/configured-executor-worker.ts
var ROUTING_ROLES = [
  "chat",
  "background",
  "coding",
  "deep",
  "deeper",
  "opus",
  "agent",
  "superdebug",
  "fast",
  "toolcaller",
  "codereview",
  "introspection"
];
function isRoutingRole(model) {
  return ROUTING_ROLES.includes(model);
}
function sendResponse(message) {
  if (process.send) {
    process.send(message);
  }
}
function serializeError(error) {
  if (isZaraacoderBlockingError(error)) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      blockingReason: error.reason
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}
async function runConfiguredExecutor(request) {
  const providers = await createProviders({
    providers: request.config.providers,
    models: request.config.models,
    privacy: request.config.privacy,
    dataDir: request.dataDir
  });
  if (!providers.router) {
    throw new Error("No providers are registered for the Zaraacoder executor.");
  }
  const provider = isRoutingRole(request.model) ? providers.router.getProvider("guarded", request.model) : providers.router.hasModel(request.model) ? providers.router.getProvider("guarded", void 0, { model: request.model }) : null;
  if (!provider) {
    throw new Error(`Zaraacoder executor model "${request.model}" is not registered.`);
  }
  const availabilitySource = {
    providers: request.config.providers,
    modelControls: request.config.modelControls,
    zaraacoder: request.config.zaraacoder
  };
  const resolvedModelKey = provider.modelKey ?? request.model;
  const providerName = findProviderForModelKey(availabilitySource, resolvedModelKey);
  if (!isModelEnabled(availabilitySource, resolvedModelKey, providerName, "zaraacoder")) {
    throw new Error(`Zaraacoder executor model "${resolvedModelKey}" is disabled.`);
  }
  const planner = createZaraacoderModelPlanner({
    chat: provider.chat.bind(provider)
  });
  const executor = createZaraacoderExecutorAdapter({
    planner,
    policy: request.policy
  });
  return executor(request.context);
}
process.on("message", (raw) => {
  const message = raw;
  if (!message || message.type !== zaraacoderIsolatedExecutorProtocol.run) {
    return;
  }
  void (async () => {
    try {
      const result = await runConfiguredExecutor(message.request);
      sendResponse({
        type: zaraacoderIsolatedExecutorProtocol.result,
        requestId: message.requestId,
        result
      });
    } catch (error) {
      sendResponse({
        type: zaraacoderIsolatedExecutorProtocol.error,
        requestId: message.requestId,
        error: serializeError(error)
      });
    } finally {
      setImmediate(() => process.exit(0));
    }
  })();
});
