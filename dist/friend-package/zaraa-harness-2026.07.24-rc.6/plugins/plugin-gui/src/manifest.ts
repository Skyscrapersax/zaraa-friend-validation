import type { PluginManifest, PluginToolDefinition } from "@zaraa/shared";

const tools: PluginToolDefinition[] = [
  {
    name: "gui_screenshot",
    description: "Capture a PNG of the current desktop (or a region). Returns base64 + dimensions.",
    parameters: {
      type: "object",
      properties: {
        region: {
          type: "object",
          properties: {
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
            w: { type: "integer", minimum: 1 },
            h: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    minZone: "sandbox",
    requiresApproval: false,
  },
  {
    name: "gui_describe",
    description: "Capture the screen and ask the local VLM to describe what is visible. Returns text.",
    parameters: {
      type: "object",
      properties: {
        focusHint: { type: "string", description: "Optional steering hint for the VLM" },
      },
    },
    minZone: "sandbox",
    requiresApproval: false,
  },
  {
    name: "gui_plan",
    description: "Capture the screen and ask the VLM to propose 1-3 next actions toward `goal`. Returns PlannedAction[]; does NOT execute.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", minLength: 1 },
      },
      required: ["goal"],
    },
    minZone: "sandbox",
    requiresApproval: false,
  },
  {
    name: "gui_wait",
    description: "Sleep for a given number of milliseconds. Useful for letting the UI settle between actions.",
    parameters: {
      type: "object",
      properties: { ms: { type: "integer", minimum: 0, maximum: 60000 } },
      required: ["ms"],
    },
    minZone: "sandbox",
    requiresApproval: false,
  },
  {
    name: "gui_scroll",
    description: "Scroll at a screen position by a delta. (Phase 4 will implement; Phase 3 returns 'not implemented'.)",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        dx: { type: "integer" },
        dy: { type: "integer" },
      },
      required: ["x", "y", "dx", "dy"],
    },
    minZone: "sandbox",
    requiresApproval: false,
  },
  {
    name: "gui_click",
    description: "Click at a screen position. Irreversible.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        clicks: { type: "integer", enum: [1, 2], default: 1 },
      },
      required: ["x", "y"],
    },
    minZone: "guarded",
    requiresApproval: true,
  },
  {
    name: "gui_key",
    description: "Send a keyboard chord, e.g. ['cmd','c']. Irreversible.",
    parameters: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
      },
      required: ["keys"],
    },
    minZone: "guarded",
    requiresApproval: true,
  },
  {
    name: "gui_type",
    description: "Type a text string. (Phase 4 will implement; Phase 3 returns 'not implemented'.) Irreversible.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        redact: { type: "boolean", default: false },
      },
      required: ["text"],
    },
    minZone: "guarded",
    requiresApproval: true,
  },
  {
    name: "gui_drag",
    description: "Drag from one screen position to another. (Phase 4 will implement; Phase 3 returns 'not implemented'.) Irreversible.",
    parameters: {
      type: "object",
      properties: {
        fromX: { type: "integer", minimum: 0 },
        fromY: { type: "integer", minimum: 0 },
        toX: { type: "integer", minimum: 0 },
        toY: { type: "integer", minimum: 0 },
        button: { type: "string", enum: ["left", "right"], default: "left" },
      },
      required: ["fromX", "fromY", "toX", "toY"],
    },
    minZone: "guarded",
    requiresApproval: true,
  },
];

export const GUI_MANIFEST: PluginManifest = {
  name: "gui",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["ui.dom"],
  trust: "verified",
  tools,
};
