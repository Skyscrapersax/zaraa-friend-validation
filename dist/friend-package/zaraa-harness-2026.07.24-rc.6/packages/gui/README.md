# @zaraa/gui

GUI agent for Zaraa. macOS only (Apple Silicon) in v1. See
`docs/superpowers/specs/2026-05-09-zaraa-gui-agent-design.md` for the design.

## Status

- ✅ Phase 1: package scaffold, Swift native helper, capture/click/key, demo:capture
- ✅ Phase 2: `VlmProvider` interface, `OllamaProvider` (local default), prompt + parser, demo:plan
- ✅ Phase 3: AgentLoop tool registration via `plugin-gui` (config.gui.enabled gate)
- ✅ Phase 4: in-process safety layer (allowlist, rate limit, sensitive-app guard, kill-switch hotkey, screenshot redaction) + Swift type/drag/scroll/frontmost
- ✅ Phase 5: remote VLM providers (Anthropic Vision, OpenAI GPT-4o) gated by `safety.remoteProvidersAllowedInZone`
- ✅ Phase 6: web dashboard panel (`/api/gui/status` endpoint + `GuiAgentPanel` polling MVP; SSE upgrade is a Phase-7 followup)

**Phase 6 complete. The GUI agent is feature-complete per the original spec.** What ships now:
- Local-first computer-use agent with Swift native helper for capture/click/type/key/drag/scroll
- Pluggable VLM providers (Ollama default + Anthropic + OpenAI), gated by zone for remote providers
- Two-layer safety: Zaraa policy engine + in-process allowlist/rate-limit/sensitive-app/kill-switch
- AgentLoop integration via `plugin-gui`, default-disabled
- Operator visibility via the GUI agent dashboard panel under Labs

## Build

```sh
pnpm --filter @zaraa/gui build         # tsup -> dist/
pnpm --filter @zaraa/gui build:native  # swift build -> ~/.zaraa/bin/
pnpm --filter @zaraa/gui test          # vitest (39 tests)
pnpm --filter @zaraa/gui demo:capture  # save /tmp/zaraa-gui-capture.png
pnpm --filter @zaraa/gui demo:plan     # capture + ask local VLM for next actions
```

## Live VLM testing

`demo:plan` uses Ollama with a vision-language model. You need to pull one first:

```sh
ollama pull qwen2.5vl:7b      # ~5 GB download, recommended default
# or, smaller:
ollama pull moondream         # ~1.6 GB, faster on small Macs
# or, larger:
ollama pull llava:13b         # ~7 GB, better grounding
```

Then run with a goal:

```sh
pnpm --filter @zaraa/gui demo:plan "open Spotlight and search Calculator"
```

Override the model or host with environment variables:

```sh
ZARAA_GUI_VLM_MODEL=moondream pnpm --filter @zaraa/gui demo:plan "your goal"
OLLAMA_HOST=http://other-host:11434 pnpm --filter @zaraa/gui demo:plan "your goal"
```

## Permissions

The native helper binary at `~/.zaraa/bin/zaraa-gui-helper` needs three macOS
TCC permissions. They're granted per-binary, not per-user, so re-grant after
every rebuild (the binary's signature changes).

1. **Screen Recording** — System Settings → Privacy & Security → Screen Recording → enable for `zaraa-gui-helper`.
2. **Accessibility** — same panel → Accessibility → enable for `zaraa-gui-helper`.
3. **Input Monitoring** — same panel → Input Monitoring → enable for `zaraa-gui-helper`.

First run triggers each prompt automatically. If you deny, the helper prints
a clear error and exits; the package stays unavailable until you grant.

## What is NOT in this package yet

- No remote VLM providers (Phase 5 — Anthropic, OpenAI).
- No web dashboard panel (Phase 6).

## What is NOT taken from ByteDance

This package is clean-room. We have read the UI-TARS paper
(`https://arxiv.org/abs/2501.12326`) and we use the open-weight Qwen 2.5-VL
model (or UI-TARS-1.5-7B once a community GGUF exists) via Ollama. We have
not copied or translated any source from `bytedance/UI-TARS` or
`bytedance/UI-TARS-desktop`. There are no telemetry endpoints, analytics
SDKs, or auto-update channels in this package.
