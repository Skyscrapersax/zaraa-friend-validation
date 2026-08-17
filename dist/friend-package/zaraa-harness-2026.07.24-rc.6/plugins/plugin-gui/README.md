# plugin-gui

Zaraa plugin that registers `gui_*` tools (9 total) into the AgentLoop with a two-layer safety net (Zaraa policy engine + in-process guard pipeline). Ships disabled.

## Enable

Two independent grants are required: computer control plus the GUI plugin.

```json
{
  "computerControl": {
    "enabled": true,
    "backends": {
      "desktop": {
        "enabled": true,
        "allowedApps": []
      }
    },
    "requiresApproval": true
  },
  "gui": {
    "enabled": true,
    "vlm": {
      "model": "qwen2.5vl:7b",
      "host": "http://127.0.0.1:11434"
    },
    "safety": {
      "actionsPerMinute": 60,
      "screenshotsPerMinute": 10,
      "sensitiveApps": ["com.example.banking"]
    }
  }
}
```

Restart Zaraa. Core registers the tools through `ComputerControlGate`, which
forces approval, session caps, and audit logging. Keep `requiresApproval: true`.

You also need:
- The Swift helper binary built + permissions granted: see `packages/gui/README.md`.
- A vision-language model pulled into Ollama: `ollama pull qwen2.5vl:7b`.

## Tool zones

| Tool | Zone | Approval | Implemented? |
|------|------|----------|--------------|
| `gui_screenshot` | sandbox | no | ✅ |
| `gui_describe` | sandbox | no | ✅ |
| `gui_plan` | sandbox | no | ✅ |
| `gui_wait` | sandbox | no | ✅ |
| `gui_scroll` | sandbox | no | ✅ Phase 4 |
| `gui_click` | guarded | yes | ✅ |
| `gui_key` | guarded | yes | ✅ |
| `gui_type` | guarded | yes | ✅ Phase 4 |
| `gui_drag` | guarded | yes | ✅ Phase 4 |

## In-process safety guard (Phase 4)

Every `gui_*` call runs through this pipeline before dispatching:

1. **Kill-switch** — fail-fast if the global hotkey (default `Ctrl+Shift+Esc`) was pressed
2. **Allowlist** — refuse any tool name not in the 9 declared above
3. **Rate limiter** — sliding window: max 60 actions/min + 10 screenshots/min (configurable)
4. **Sensitive-app guard** — refuse capture/input when frontmost app is 1Password, Keychain, or anything in `safety.sensitiveApps`
5. **Audit log** — every call writes a row through Zaraa's existing AuditLogger

Failures throw `GuiPolicyError` with a `code` field (`kill_switch`, `allowlist`, `rate_limit`, `sensitive_app`) so the agent loop can distinguish from transport errors.

## What is NOT in this plugin yet

- Attached browser sessions and dedicated browser profiles. Current GUI control
  operates the frontmost desktop app; `BrowserSandbox` launches fresh Chromium.
  A later authorized-session controller needs a separate Chrome profile created
  by the user, Chrome launched with CDP bound to loopback only, user-performed
  sign-in, and controller attachment to that local endpoint. Never expose the
  endpoint through a LAN bind or tunnel. Read-only inspection may use the
  authorized session; posting, messaging, downloads, purchases,
  credential/financial form entry, and destructive actions still require
  explicit approval. This repo does not configure or launch that controller.
- Helper lifecycle is lazy (start on first call); Phase 5+ should start at plugin load and stop on shutdown.
- Audit-log entries don't yet include screenshot SHA-256 — see followups doc.
- Kill-switch reset is process-restart only; Phase 5 should expose a CLI/API.
