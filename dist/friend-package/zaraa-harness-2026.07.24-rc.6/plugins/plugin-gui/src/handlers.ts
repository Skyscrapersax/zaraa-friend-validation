import type { HelperClient, VlmProvider } from "@zaraa/gui";
import type { GuardSpec, PolicyGuard } from "./policy-guard.js";

export type GuiHandlerDeps = {
  helper: Pick<
    HelperClient,
    "start" | "stop" | "capture" | "click" | "key" | "type" | "drag" | "scroll" | "frontmostApp" | "onHotkey"
  >;
  vlm: Pick<VlmProvider, "name" | "isLocal" | "plan">;
  policyGuard: PolicyGuard;
};

type Handler = (args: Record<string, unknown>, context?: unknown) => Promise<unknown>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SPECS: Record<string, GuardSpec> = {
  gui_screenshot: { toolName: "gui_screenshot", bucket: "screenshot", requiresFrontmostCheck: false },
  gui_describe:   { toolName: "gui_describe",   bucket: "screenshot", requiresFrontmostCheck: false },
  gui_plan:       { toolName: "gui_plan",       bucket: "screenshot", requiresFrontmostCheck: false },
  gui_wait:       { toolName: "gui_wait",       bucket: "none",       requiresFrontmostCheck: false },
  gui_scroll:     { toolName: "gui_scroll",     bucket: "input",      requiresFrontmostCheck: true  },
  gui_click:      { toolName: "gui_click",      bucket: "input",      requiresFrontmostCheck: true  },
  gui_key:        { toolName: "gui_key",        bucket: "input",      requiresFrontmostCheck: true  },
  gui_type:       { toolName: "gui_type",       bucket: "input",      requiresFrontmostCheck: true  },
  gui_drag:       { toolName: "gui_drag",       bucket: "input",      requiresFrontmostCheck: true  },
};

export function createGuiHandlers(deps: GuiHandlerDeps): Record<string, Handler> {
  const { helper, vlm, policyGuard } = deps;

  return {
    gui_screenshot: async (args) =>
      policyGuard(SPECS.gui_screenshot, async () => {
        await helper.start();
        const region = (args as { region?: { x: number; y: number; w: number; h: number } }).region;
        return helper.capture(region);
      }),

    gui_describe: async (args) =>
      policyGuard(SPECS.gui_describe, async () => {
        await helper.start();
        const ss = await helper.capture();
        const focusHint = (args as { focusHint?: string }).focusHint;
        const goal = focusHint
          ? `describe what is on the screen, with attention to: ${focusHint}`
          : "describe what is on the screen";
        const plans = await vlm.plan(
          {
            screenshotBase64: ss.pngBase64,
            width: ss.width,
            height: ss.height,
            goal,
          },
          [],
        );
        const description = plans.find((p) => p.thought)?.thought ?? "";
        return { description, plans };
      }),

    gui_plan: async (args) =>
      policyGuard(SPECS.gui_plan, async () => {
        const goal = (args as { goal: string }).goal;
        await helper.start();
        const ss = await helper.capture();
        return vlm.plan(
          {
            screenshotBase64: ss.pngBase64,
            width: ss.width,
            height: ss.height,
            goal,
          },
          [],
        );
      }),

    gui_wait: async (args) =>
      policyGuard(SPECS.gui_wait, async () => {
        const ms = Math.max(0, Math.min(60000, Number((args as { ms: number }).ms) || 0));
        await sleep(ms);
        return { ok: true, ms };
      }),

    gui_scroll: async (args) => {
      const a = args as { x: number; y: number; dx: number; dy: number };
      return policyGuard(SPECS.gui_scroll, async () => {
        await helper.start();
        await helper.scroll(a);
        return { ok: true };
      });
    },

    gui_click: async (args) => {
      const a = args as { x: number; y: number; button?: "left" | "right" | "middle"; clicks?: 1 | 2 };
      return policyGuard(SPECS.gui_click, async () => {
        await helper.start();
        await helper.click({
          x: a.x,
          y: a.y,
          button: a.button ?? "left",
          clicks: a.clicks ?? 1,
        });
        return { ok: true };
      });
    },

    gui_key: async (args) => {
      const keys = (args as { keys: string[] }).keys;
      return policyGuard(SPECS.gui_key, async () => {
        await helper.start();
        await helper.key(keys);
        return { ok: true };
      });
    },

    gui_type: async (args) => {
      const text = (args as { text: string }).text;
      return policyGuard(SPECS.gui_type, async () => {
        await helper.start();
        await helper.type(text);
        return { ok: true };
      });
    },

    gui_drag: async (args) => {
      const a = args as { fromX: number; fromY: number; toX: number; toY: number; button?: "left" | "right" };
      return policyGuard(SPECS.gui_drag, async () => {
        await helper.start();
        await helper.drag({ ...a, button: a.button ?? "left" });
        return { ok: true };
      });
    },
  };
}
