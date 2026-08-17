import {
  applyFriendMoneySafety
} from "./chunk-ZXGRN7XQ.js";

// src/setup-wizard/first-run-config.mjs
import { randomBytes } from "crypto";
function buildFirstRunConfig(opts) {
  const home = opts.home;
  const ollama = opts.ollama === true;
  const base = {
    defaultZone: "sandbox",
    zones: {
      guarded: {
        files: {
          allow: [`${home}/Documents/**`, `${home}/Projects/**`]
        },
        network: {
          allow: ["api.anthropic.com", "api.openai.com", "localhost:11434"]
        },
        shell: {
          allow: [
            "ls",
            "ls *",
            "git status",
            "git log",
            "git diff",
            "git show",
            "git branch",
            "git rev-parse",
            "echo *"
          ],
          approve: ["rm *", "mv *", "cp *"]
        }
      },
      trusted: {
        enabled: false,
        requireAuth: true,
        autoDowngrade: { afterMinutes: 60, onAnomaly: true }
      }
    },
    gateway: {
      auth: {
        // Minted once on first run; installers never rotate a set key.
        apiKey: randomBytes(32).toString("base64url")
      }
    },
    providers: ollama ? [
      {
        name: "ollama",
        type: "ollama",
        baseUrl: "http://localhost:11434",
        models: ["llama3.2:3b"]
      }
    ] : [],
    models: { default: ollama ? "llama3.2:3b" : "claude-sonnet-5" },
    privacy: {
      confidential: [`${home}/.ssh/**`, `${home}/.env*`],
      neverSendPatterns: ["sk-", "ghp_", "AKIA"],
      onConfidentialAccess: "ask",
      promptInspection: "log",
      networkMode: "selective"
    },
    scheduler: {
      tasks: [],
      watchdogs: [],
      overnight: { enabled: false },
      limits: {
        maxTokensPerDay: 1e6,
        maxTasksPerHour: 60,
        maxCostPerDay: "$10",
        pauseOnBudgetExhaust: true
      }
    },
    // Friend-beta idle surface until operator enables intentionally.
    calendar: { enabled: false },
    messaging: { imessage: { enabled: false } },
    voice: { enabled: false, facetime: { enabled: false } },
    autonomy: { creativeJoy: { enabled: false } },
    performance: ollama ? "auto" : "minimal"
  };
  return applyFriendMoneySafety(base);
}
export {
  buildFirstRunConfig
};
