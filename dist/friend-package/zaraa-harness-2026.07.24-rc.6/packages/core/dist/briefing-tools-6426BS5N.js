import {
  composeBriefingNarration,
  serializeBriefingPacket
} from "./chunk-UGPITNG4.js";
import "./chunk-R5U7XKVJ.js";

// src/proactive/briefing-tools.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// src/notifications/notification-composer.ts
var CATEGORY_PREFIX = {
  task: "[Task]",
  trading: "[Trading]",
  calendar: "[Calendar]",
  security: "[Security]",
  learning: "[Learning]",
  system: "[System]",
  message: "[Message]",
  finance: "[Finance]"
};
function composeDailyBriefing(briefing) {
  return {
    title: `${CATEGORY_PREFIX.system} Daily Briefing`,
    body: composeBriefingNarration(briefing),
    category: "system",
    actions: ["View full briefing"],
    groupKey: "briefing"
  };
}

// src/proactive/briefing-tools.ts
function dailyBriefingDeliveryKey(now = /* @__PURE__ */ new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `daily-briefing:${year}-${month}-${day}`;
}
function createFileBriefingDeliveryLedger(dir) {
  const fileFor = (key) => join(dir, `${key.replace(/[^a-zA-Z0-9:_-]/g, "")}.json`);
  return {
    get(key) {
      try {
        return readFileSync(fileFor(key), "utf8");
      } catch {
        return null;
      }
    },
    set(key, receipt) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(fileFor(key), receipt);
    }
  };
}
var IOS_PRIMARY_SURFACE = "ios-chat";
var IOS_PRIMARY_INTERACTION_MODE = "chat";
var IOS_PRIMARY_FALLBACK_WINDOW_MS = 30 * 60 * 1e3;
var DEFAULT_BRIEFING_SESSION_ID = "ios-primary-briefing";
function operatorSessionId(contact) {
  return `imessage-${contact.replace(/[^a-zA-Z0-9]/g, "")}`;
}
function resolveBriefingSessionId(deps) {
  const operatorContact = typeof deps.operatorContact === "string" ? deps.operatorContact.trim() : "";
  return operatorContact ? operatorSessionId(operatorContact) : DEFAULT_BRIEFING_SESSION_ID;
}
var manifest = {
  name: "briefings",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["assistant.briefings"],
  trust: "core",
  tools: [
    {
      name: "briefing_get_daily",
      description: "Generate the structured daily briefing packet from goals, tasks, calendar, finance, trading, and system state.",
      parameters: {
        type: "object",
        properties: {
          voiceWindow: {
            type: "string",
            enum: ["morning", "afternoon", "night"]
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "briefing_deliver_daily",
      description: "Generate the daily briefing packet and deliver its summary through Zaraa's notification channels.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    }
  ]
};
function createHandlers(deps) {
  const parseVoiceWindow = (raw) => {
    return raw === "morning" || raw === "afternoon" || raw === "night" ? raw : void 0;
  };
  return {
    briefing_get_daily: async (args) => {
      const briefing = await deps.generateDailyBriefing();
      const voiceWindow = parseVoiceWindow(args?.voiceWindow);
      return JSON.stringify(serializeBriefingPacket(briefing, { voiceWindow }));
    },
    briefing_deliver_daily: async () => {
      const notificationId = dailyBriefingDeliveryKey(deps.now?.() ?? /* @__PURE__ */ new Date());
      const existing = await deps.deliveryLedger?.get(notificationId);
      if (existing) {
        try {
          const parsed = JSON.parse(existing);
          return JSON.stringify({ ...parsed, reused: true });
        } catch {
          return JSON.stringify({
            delivered: true,
            reused: true,
            notificationId
          });
        }
      }
      const briefing = await deps.generateDailyBriefing();
      const composed = composeDailyBriefing(briefing);
      const serializedBriefing = serializeBriefingPacket(briefing);
      const { narration, voiceScript } = serializedBriefing;
      const sessionId = resolveBriefingSessionId(deps);
      if (deps.sessionWriter) {
        await deps.sessionWriter.createSession(sessionId, {
          title: "Daily Briefing",
          primarySurface: IOS_PRIMARY_SURFACE,
          interactionMode: IOS_PRIMARY_INTERACTION_MODE,
          fallbackEligible: true,
          fallbackReason: "daily_briefing_unopened"
        });
        await deps.sessionWriter.addMessage(
          sessionId,
          "assistant",
          `Daily briefing

${composed.body}`,
          {
            kind: "daily-briefing",
            notificationId,
            generatedAt: briefing.generatedAt
          }
        );
      }
      if (deps.notify) {
        await deps.notify(composed.body, {
          title: composed.title,
          priority: "normal",
          channels: ["websocket", "os", "imessage"],
          kind: "daily-briefing",
          state: "ready",
          metadata: {
            sessionId,
            surface: IOS_PRIMARY_SURFACE,
            primarySurface: IOS_PRIMARY_SURFACE,
            deliveryTarget: IOS_PRIMARY_SURFACE,
            interactionMode: IOS_PRIMARY_INTERACTION_MODE,
            fallbackEligible: true,
            fallbackChannels: ["imessage"],
            fallbackWindowMs: IOS_PRIMARY_FALLBACK_WINDOW_MS,
            fallbackReason: "daily_briefing_unopened",
            notificationId,
            notificationKind: "daily-briefing",
            renderKind: "daily-briefing",
            skipSessionRecord: true,
            briefing: serializedBriefing,
            narration,
            voiceScript
          }
        });
      }
      const receipt = JSON.stringify({
        delivered: Boolean(deps.notify),
        reused: false,
        sessionId,
        notificationId,
        title: composed.title,
        ...serializedBriefing,
        sections: (serializedBriefing.sections ?? []).map(
          ({ content: _content, ...rest }) => rest
        )
      });
      await deps.deliveryLedger?.set(notificationId, receipt);
      return receipt;
    }
  };
}
export {
  createFileBriefingDeliveryLedger,
  createHandlers,
  dailyBriefingDeliveryKey,
  manifest
};
