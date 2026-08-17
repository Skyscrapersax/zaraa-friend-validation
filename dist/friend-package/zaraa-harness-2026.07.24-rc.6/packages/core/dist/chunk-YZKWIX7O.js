// src/voice/call-tools.ts
var manifest = {
  name: "phone-calls",
  version: "1.0.0",
  type: "tool",
  minZone: "trusted",
  capabilities: ["voice.call"],
  trust: "core",
  tools: [
    {
      name: "call_dial",
      description: "Call a phone number. Zaraa will speak to the person using voice (STT \u2192 agent \u2192 TTS). Only one call can be active at a time. The call connects via Twilio and streams audio bidirectionally so you can have a real conversation.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Phone number to call in E.164 format (e.g. '+14155551234'). Must include country code."
          }
        },
        required: ["to"]
      },
      requiresApproval: true
    },
    {
      name: "call_hangup",
      description: "Hang up the current active call.",
      parameters: {
        type: "object",
        properties: {
          callSid: {
            type: "string",
            description: "Twilio Call SID. Omit to hang up the current active call."
          }
        },
        required: []
      },
      requiresApproval: true
    },
    {
      name: "call_status",
      description: "Get the status of the current active call (ringing, in-progress, etc.).",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "call_history",
      description: "Get recent call history.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum entries to return (default: 20)"
          }
        },
        required: []
      },
      requiresApproval: false
    }
  ]
};
var E164_REGEX = /^\+[1-9]\d{1,14}$/;
function createCallHandlers(deps) {
  const { callManager } = deps;
  return {
    call_dial: async (args) => {
      const to = args.to;
      if (!to) throw new Error("to is required");
      if (!E164_REGEX.test(to)) {
        throw new Error(
          `Invalid phone number "${to}". Must be E.164 format (e.g. +14155551234).`
        );
      }
      try {
        const info = await callManager.dial(to);
        return JSON.stringify({
          ok: true,
          callSid: info.callSid,
          to: info.to,
          from: info.from,
          state: info.state,
          message: `Calling ${to}... The call will connect through Twilio and you'll be able to speak.`
        });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    },
    call_hangup: async (args) => {
      const callSid = args.callSid;
      try {
        await callManager.hangup(callSid);
        return JSON.stringify({ ok: true, message: "Call ended." });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    },
    call_status: async () => {
      const info = callManager.getActiveCallInfo();
      if (!info) {
        return JSON.stringify({ active: false, message: "No active call." });
      }
      return JSON.stringify({
        active: true,
        callSid: info.callSid,
        to: info.to,
        from: info.from,
        state: info.state,
        startedAt: info.startedAt,
        duration: info.duration
      });
    },
    call_history: async (args) => {
      const limit = args.limit ?? 20;
      const history = callManager.getHistory(limit);
      if (history.length === 0) {
        return JSON.stringify({ message: "No call history.", calls: [] });
      }
      return JSON.stringify({
        count: history.length,
        calls: history
      });
    }
  };
}

export {
  manifest,
  createCallHandlers
};
