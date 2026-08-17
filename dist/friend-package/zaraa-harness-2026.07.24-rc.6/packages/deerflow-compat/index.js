import { createRequire } from "node:module";

const requireNative = createRequire(import.meta.url);

const MAX_RAW_JSON_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_PAYLOAD_BYTES = 4096;
const PAYLOAD_PREVIEW_BYTES = 512;
const MAX_STREAM_MODES = 8;
const MAX_STREAM_MODE_CHARS = 64;
const MAX_THREAD_ID_CHARS = 256;
const MAX_SKILL_NAME_CHARS = 120;

function loadNative() {
  const candidates = [
    "./deerflow_compat.node",
    "./deerflow-compat.node",
    "./index.node",
    "./deerflow_compat.darwin-arm64.node",
    "./deerflow_compat.darwin-x64.node",
    "./deerflow_compat.linux-x64-gnu.node",
    "./deerflow_compat.linux-x64-musl.node",
    "./deerflow_compat.linux-arm64-gnu.node",
    "./deerflow_compat.linux-arm64-musl.node",
    "./deerflow_compat.win32-x64-msvc.node",
    "./deerflow_compat.win32-arm64-msvc.node"
  ];

  for (const candidate of candidates) {
    try {
      return requireNative(candidate);
    } catch {
      // Keep the loader side-effect-free and fall back when native bindings are absent.
    }
  }

  return null;
}

const native = loadNative();

function jsonOk(value) {
  return JSON.stringify({ ok: true, ...value });
}

function jsonError(code, message) {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function charLength(value) {
  return Array.from(value).length;
}

function utf8Prefix(value, maxBytes) {
  let bytes = 0;
  let output = "";

  for (const char of value) {
    const next = byteLength(char);
    if (bytes + next > maxBytes) {
      break;
    }
    output += char;
    bytes += next;
  }

  return output;
}

function normalizePayload(value) {
  const serialized = JSON.stringify(value);
  const sizeBytes = byteLength(serialized);

  if (sizeBytes <= MAX_PAYLOAD_BYTES) {
    return value;
  }

  return {
    __truncated: true,
    __sizeBytes: sizeBytes,
    __preview: utf8Prefix(serialized, PAYLOAD_PREVIEW_BYTES)
  };
}

function parseStreamModes(request) {
  const keys = ["streamModes", "stream_modes", "streamMode", "stream_mode"];
  let value;
  let hasValue = false;

  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(request, key)) {
      value = request[key];
      hasValue = true;
      break;
    }
  }

  if (!hasValue) {
    return { ok: true, modes: [] };
  }

  const modes = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (modes === null) {
    return { ok: false, code: "invalid_stream_modes", message: "stream modes must be a string or an array of strings" };
  }

  if (modes.length > MAX_STREAM_MODES) {
    return { ok: false, code: "too_many_stream_modes", message: "stream modes may include at most 8 entries" };
  }

  const normalized = [];
  for (const mode of modes) {
    if (typeof mode !== "string") {
      return { ok: false, code: "invalid_stream_mode", message: "each stream mode must be a string" };
    }

    const trimmed = mode.trim();
    if (trimmed.length === 0) {
      return { ok: false, code: "invalid_stream_mode", message: "stream modes may not be empty" };
    }

    if (charLength(trimmed) > MAX_STREAM_MODE_CHARS) {
      return { ok: false, code: "stream_mode_too_long", message: "stream modes may not exceed 64 characters" };
    }

    normalized.push(trimmed);
  }

  return { ok: true, modes: normalized };
}

function parseLangGraphRunRequestFallback(rawJson) {
  if (typeof rawJson !== "string") {
    return jsonError("invalid_raw_json", "rawJson must be a string");
  }

  if (byteLength(rawJson) > MAX_RAW_JSON_BYTES) {
    return jsonError("raw_json_too_large", "raw JSON may not exceed 16 KiB");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return jsonError("invalid_json", "rawJson must contain valid JSON");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonError("invalid_request", "LangGraph run request must be a JSON object");
  }

  const message = extractMessage(parsed);
  if (message.length === 0) {
    return jsonError("missing_message", "message is required and may not be empty");
  }

  if (charLength(message) > MAX_MESSAGE_CHARS) {
    return jsonError("message_too_long", "message may not exceed 4000 characters");
  }

  const streamModes = parseStreamModes(parsed);
  if (!streamModes.ok) {
    return jsonError(streamModes.code, streamModes.message);
  }

  const request = {
    message,
    streamModes: streamModes.modes
  };

  if (Object.prototype.hasOwnProperty.call(parsed, "input")) {
    request.input = normalizePayload(parsed.input);
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "config")) {
    request.config = normalizePayload(parsed.config);
  }

  return jsonOk({ request });
}

function extractMessage(request) {
  const input = request.input && typeof request.input === "object" && !Array.isArray(request.input)
    ? request.input
    : {};
  const messages = Array.isArray(input.messages) ? input.messages : [];

  for (const entry of messages) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const role = typeof entry.role === "string" ? entry.role.trim().toLowerCase() : "";
    const content = typeof entry.content === "string" ? entry.content.trim() : "";
    if (content && (!role || role === "user")) {
      return content;
    }
  }

  for (const candidate of [input.content, request.message, input.prompt]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function isThreadIdChar(char) {
  return /^[A-Za-z0-9._:-]$/.test(char);
}

function normalizeThreadIdFallback(raw) {
  if (typeof raw !== "string") {
    return jsonError("invalid_thread_id", "thread id must be a string");
  }

  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code <= 31 || code === 127) {
      return jsonError("invalid_thread_id", "thread id contains unsafe characters");
    }
  }

  const threadId = raw.trim();
  if (threadId.length === 0) {
    return jsonError("empty_thread_id", "thread id may not be empty");
  }

  if (charLength(threadId) > MAX_THREAD_ID_CHARS) {
    return jsonError("thread_id_too_long", "thread id may not exceed 256 characters");
  }

  if (threadId.includes("/") || threadId.includes("\\") || threadId.includes("..")) {
    return jsonError("invalid_thread_id", "thread id may not contain path separators or traversal");
  }

  for (const char of threadId) {
    const code = char.codePointAt(0);
    if (code <= 31 || code === 127 || !isThreadIdChar(char)) {
      return jsonError("invalid_thread_id", "thread id contains unsafe characters");
    }
  }

  return jsonOk({ threadId });
}

function isSkillNameChar(char) {
  return /^[A-Za-z0-9._-]$/.test(char);
}

function sanitizeSkillNameFallback(raw) {
  if (typeof raw !== "string") {
    return jsonError("invalid_skill_name", "skill name must be a string");
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return jsonError("empty_skill_name", "skill name may not be empty");
  }

  if (charLength(trimmed) > MAX_SKILL_NAME_CHARS) {
    return jsonError("skill_name_too_long", "skill name may not exceed 120 characters");
  }

  let sanitized = "";
  for (const char of trimmed) {
    if (isSkillNameChar(char)) {
      sanitized += char === "." && sanitized.endsWith(".") ? "_" : char;
    } else {
      sanitized += "_";
    }
  }

  while (sanitized.includes("..")) {
    sanitized = sanitized.replaceAll("..", "__");
  }

  sanitized = sanitized.replaceAll("/", "_").replaceAll("\\", "_");
  return jsonOk({ skillName: sanitized });
}

export function parseLangGraphRunRequest(rawJson) {
  if (native?.parseLangGraphRunRequest) {
    return native.parseLangGraphRunRequest(rawJson);
  }

  return parseLangGraphRunRequestFallback(rawJson);
}

export function normalizeThreadId(raw) {
  if (native?.normalizeThreadId) {
    return native.normalizeThreadId(raw);
  }

  return normalizeThreadIdFallback(raw);
}

export function sanitizeSkillName(raw) {
  if (native?.sanitizeSkillName) {
    return native.sanitizeSkillName(raw);
  }

  return sanitizeSkillNameFallback(raw);
}

export function compatBackend() {
  if (native?.compatBackend) {
    return native.compatBackend();
  }

  return "js-fallback";
}

export default {
  parseLangGraphRunRequest,
  normalizeThreadId,
  sanitizeSkillName,
  compatBackend
};
