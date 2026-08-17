import {
  reassertFaceTimeDevices
} from "./chunk-XPG3N6Q6.js";
import {
  BLACKHOLE_DEVICE,
  FT_MULTI_OUTPUT_DEVICE
} from "./chunk-RABT6PUR.js";

// src/voice/facetime-tools.ts
var manifest = {
  name: "facetime-calls",
  version: "1.1.0",
  type: "tool",
  minZone: "trusted",
  capabilities: ["voice.facetime"],
  trust: "core",
  tools: [
    {
      name: "ft_call",
      description: "Call someone via FaceTime Audio. Zaraa will speak using voice (STT \u2192 agent \u2192 TTS). Works with phone numbers, emails, or Apple IDs. macOS only. Only one call at a time. Requires BlackHole 2ch; two-way needs Multi-Output 'Zaraa FT Out'.",
      parameters: {
        type: "object",
        properties: {
          contact: {
            type: "string",
            description: "Who to call \u2014 phone number (+14155551234), email, or Apple ID"
          }
        },
        required: ["contact"]
      },
      requiresApproval: true
    },
    {
      name: "ft_hangup",
      description: "End the current FaceTime call and restore audio devices.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: true
    },
    {
      name: "ft_status",
      description: "Get the status of the current FaceTime call including mic/out devices.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    }
  ]
};
function createFaceTimeHandlers(deps) {
  let activeSession = null;
  let deviceHoldTimer = null;
  const clearDeviceHold = () => {
    if (deviceHoldTimer) {
      clearInterval(deviceHoldTimer);
      deviceHoldTimer = null;
    }
  };
  const callEnded = (s) => activeSession !== s || s.callInfo.state === "completed";
  const rolesFromSession = (session) => ({
    micDevice: session.callInfo.micDevice || BLACKHOLE_DEVICE,
    outDevice: session.callInfo.outDevice || (session.callInfo.multiOutputReady ? FT_MULTI_OUTPUT_DEVICE : BLACKHOLE_DEVICE),
    multiOutputReady: Boolean(session.callInfo.multiOutputReady)
  });
  return {
    ft_call: async (args) => {
      const contact = args.contact;
      if (!contact) throw new Error("contact is required");
      if (activeSession) {
        return JSON.stringify({
          ok: false,
          error: "A FaceTime call is already active. Hang up first."
        });
      }
      try {
        const session = await deps.provider.call(contact);
        session.configure({
          sttFn: deps.sttFn,
          ttsFn: deps.ttsFn,
          chatFn: deps.chatFn
        });
        activeSession = session;
        const roles = rolesFromSession(session);
        setTimeout(async () => {
          if (callEnded(session)) return;
          const reassert = async () => {
            await reassertFaceTimeDevices(roles);
          };
          await reassert();
          const greetText = deps.greeting || "Hey, it's Zaraa. Can you hear me? Say something and I'll answer.";
          for (let i = 0; i < 2; i++) {
            if (callEnded(session)) return;
            try {
              await reassert();
              const pcm = await deps.ttsFn(greetText);
              session.emit("audio", pcm);
              await session.speakPcm(pcm);
              console.log(`[facetime-tools] greeting playback ${i + 1}/2 ok`);
            } catch (err) {
              console.warn("[facetime-tools] greeting playback failed", err);
              session.callInfo.lastGreetingOk = false;
            }
            await new Promise((r) => setTimeout(r, 800));
          }
          if (!callEnded(session)) {
            await reassert();
            session.startCapture();
            clearDeviceHold();
            deviceHoldTimer = setInterval(() => {
              if (callEnded(session)) {
                clearDeviceHold();
                return;
              }
              void reassert();
            }, 4e3);
          }
        }, 6e3);
        return JSON.stringify({
          ok: true,
          to: contact,
          state: session.callInfo.state,
          micDevice: session.callInfo.micDevice,
          outDevice: session.callInfo.outDevice,
          multiOutputReady: session.callInfo.multiOutputReady,
          message: session.callInfo.multiOutputReady ? `Calling ${contact} via FaceTime Audio (two-way graph ready)... Answer to talk.` : `Calling ${contact} via FaceTime Audio... Multi-Output "${FT_MULTI_OUTPUT_DEVICE}" missing \u2014 you may need it for her to hear you. Answer the call.`
        });
      } catch (err) {
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    },
    ft_hangup: async () => {
      if (!activeSession) {
        return JSON.stringify({
          ok: false,
          error: "No active FaceTime call."
        });
      }
      try {
        clearDeviceHold();
        await deps.provider.hangup(activeSession);
        const duration = activeSession.callInfo.duration;
        activeSession = null;
        return JSON.stringify({
          ok: true,
          message: `Call ended${duration ? ` (${duration}s)` : ""}.`
        });
      } catch (err) {
        clearDeviceHold();
        activeSession = null;
        return JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    },
    ft_status: async () => {
      if (!activeSession) {
        return JSON.stringify({ active: false, message: "No active FaceTime call." });
      }
      return JSON.stringify({
        active: true,
        to: activeSession.callInfo.to,
        state: activeSession.callInfo.state,
        startedAt: activeSession.callInfo.startedAt,
        duration: activeSession.callInfo.duration,
        micDevice: activeSession.callInfo.micDevice,
        outDevice: activeSession.callInfo.outDevice,
        multiOutputReady: activeSession.callInfo.multiOutputReady,
        lastGreetingOk: activeSession.callInfo.lastGreetingOk
      });
    }
  };
}

export {
  manifest,
  createFaceTimeHandlers
};
