import "./chunk-R5U7XKVJ.js";

// src/voice/openai-realtime-tts.ts
var REALTIME_WS_URL = "wss://api.openai.com/v1/realtime";
var VERBATIM_TTS_INSTRUCTIONS = "You are a text-to-speech engine. Speak the user's text aloud verbatim. Output only the spoken words; add nothing, do not answer, react, or comment.";
function createRealtimeTts(deps) {
  const model = deps.model || "gpt-realtime";
  const voice = deps.voice || "alloy";
  const timeoutMs = deps.timeoutMs ?? 3e4;
  const openSocket = deps.openSocket ?? ((url, protocols) => new WebSocket(url, protocols));
  return (text) => new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let socket = null;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        socket?.close();
      } catch {
      }
    };
    const succeed = (audio) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(audio);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    deps.mintSecret({ type: "realtime", model }).then((secret) => {
      if (settled) return;
      timer = setTimeout(
        () => fail(new Error(`Realtime TTS timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      socket = openSocket(REALTIME_WS_URL, [
        "realtime",
        `openai-insecure-api-key.${secret.value}`
      ]);
      socket.onopen = () => {
        socket?.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: VERBATIM_TTS_INSTRUCTIONS,
              output_modalities: ["audio"],
              audio: { output: { voice, format: { type: "audio/pcm", rate: 24e3 } } }
            }
          })
        );
        socket?.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
          })
        );
        socket?.send(JSON.stringify({ type: "response.create" }));
      };
      socket.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case "response.output_audio.delta":
            if (msg.delta) chunks.push(Buffer.from(msg.delta, "base64"));
            break;
          case "response.done":
            succeed(Buffer.concat(chunks));
            break;
          case "error":
            fail(new Error(msg.error?.message || "Realtime TTS error"));
            break;
        }
      };
      socket.onerror = () => fail(new Error("Realtime TTS socket error"));
      socket.onclose = () => fail(new Error("Realtime TTS socket closed before completion"));
    }).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
}
export {
  createRealtimeTts
};
