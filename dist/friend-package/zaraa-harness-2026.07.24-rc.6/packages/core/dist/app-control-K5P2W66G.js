import {
  escapeAppleScript
} from "./chunk-ZLPP35NN.js";
import "./chunk-R5U7XKVJ.js";

// src/osa/app-control.ts
var SCREEN_CAPTURE_COMMAND = "/usr/sbin/screencapture";
var manifest = {
  name: "app-control",
  version: "1.0.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["os.automation"],
  trust: "core",
  tools: [
    {
      name: "app_list_running",
      description: "List all currently running applications on macOS",
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      requiresApproval: false
    },
    {
      name: "app_launch",
      description: "Launch (open) a macOS application by name. Example: 'Safari', 'Terminal', 'Notes'",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name (e.g. 'Safari', 'Finder', 'Notes')"
          }
        },
        required: ["app"]
      },
      requiresApproval: true
    },
    {
      name: "app_quit",
      description: "Quit a running macOS application by name",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name to quit"
          }
        },
        required: ["app"]
      },
      requiresApproval: true
    },
    {
      name: "app_activate",
      description: "Bring a running macOS application to the foreground",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name to activate"
          }
        },
        required: ["app"]
      },
      requiresApproval: false
    },
    {
      name: "app_script",
      description: `Run an AppleScript command targeting a specific application. Use 'tell application "AppName"' blocks to control any scriptable macOS app. Examples: open URLs in Safari, create notes, control Music playback, manage Finder windows, interact with System Preferences, etc.`,
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "AppleScript code to execute. Can include 'tell application' blocks, UI scripting via System Events, or any valid AppleScript."
          }
        },
        required: ["script"]
      },
      requiresApproval: true
    },
    {
      name: "app_get_windows",
      description: "Get the list of open windows for a specific application, including their names and positions",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name"
          }
        },
        required: ["app"]
      },
      requiresApproval: false
    },
    {
      name: "app_menu_action",
      description: "Click a menu item in a macOS application via UI scripting. Path format: 'File > Save As...' or 'Edit > Find > Find...'",
      parameters: {
        type: "object",
        properties: {
          app: {
            type: "string",
            description: "Application name"
          },
          menuPath: {
            type: "string",
            description: "Menu path separated by ' > ', e.g. 'File > New', 'Edit > Paste', 'View > Show Sidebar'"
          }
        },
        required: ["app", "menuPath"]
      },
      requiresApproval: true
    },
    {
      name: "app_type_text",
      description: "Type text into the currently focused application using keyboard simulation. Useful for filling forms, writing in editors, etc.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "Text to type"
          }
        },
        required: ["text"]
      },
      requiresApproval: true
    },
    {
      name: "app_keystroke",
      description: "Send a keyboard shortcut to the frontmost application. Supports modifiers: command, option, control, shift.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Key to press (e.g. 'c', 'v', 'z', 'return', 'tab', 'space', 'delete')"
          },
          modifiers: {
            type: "array",
            items: {
              type: "string",
              enum: ["command", "option", "control", "shift"]
            },
            description: "Modifier keys to hold (e.g. ['command'] for Cmd+key)"
          }
        },
        required: ["key"]
      },
      requiresApproval: true
    },
    {
      name: "app_open_url",
      description: "Open a URL in the default browser",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to open"
          }
        },
        required: ["url"]
      },
      requiresApproval: true
    },
    // ── Remote Control tools ───────────────────────────────────────
    {
      name: "rc_screenshot",
      description: "Capture a screenshot of the full screen or a specific app window. Returns the file path to the saved PNG.",
      parameters: { type: "object", properties: {
        mode: { type: "string", enum: ["fullscreen", "window"], description: "fullscreen or window (default: fullscreen)" },
        app: { type: "string", description: "App name for window capture (required when mode=window)" }
      }, required: [] },
      requiresApproval: false
    },
    {
      name: "rc_clipboard_read",
      description: "Read the current contents of the macOS clipboard/pasteboard.",
      parameters: { type: "object", properties: {}, required: [] },
      requiresApproval: false
    },
    {
      name: "rc_clipboard_write",
      description: "Write text to the macOS clipboard/pasteboard.",
      parameters: { type: "object", properties: {
        text: { type: "string", description: "Text to write to clipboard" }
      }, required: ["text"] },
      requiresApproval: true
    },
    {
      name: "rc_system_info",
      description: "Get macOS system info: CPU load, memory usage, disk space, battery, network. Specify categories or omit for all.",
      parameters: { type: "object", properties: {
        categories: { type: "array", items: { type: "string", enum: ["cpu", "memory", "disk", "battery", "network", "all"] }, description: "Info categories (default: all)" }
      }, required: [] },
      requiresApproval: false
    },
    {
      name: "rc_notify",
      description: "Send a macOS notification banner with a title and message.",
      parameters: { type: "object", properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification body" },
        sound: { type: "string", description: "Sound name (default, Basso, Blow, Frog, Funk, Glass, Hero, Ping, Pop, Purr, Sosumi, Tink)" }
      }, required: ["title", "message"] },
      requiresApproval: false
    },
    {
      name: "rc_open_file",
      description: "Open a file in its default app, or specify which app to use.",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "Absolute file path" },
        app: { type: "string", description: "Optional: app to open with (e.g. 'Visual Studio Code', 'Preview')" }
      }, required: ["path"] },
      requiresApproval: true
    },
    {
      name: "rc_processes",
      description: "List running processes with PID, CPU%, memory%, and name. Optionally filter by name.",
      parameters: { type: "object", properties: {
        search: { type: "string", description: "Filter by process name (case-insensitive)" },
        limit: { type: "number", description: "Max results (default: 20, max: 100)" }
      }, required: [] },
      requiresApproval: false
    },
    {
      name: "rc_volume",
      description: "Get or set macOS system volume (0-100) and mute state.",
      parameters: { type: "object", properties: {
        level: { type: "number", description: "Volume 0-100. Omit to just read." },
        mute: { type: "boolean", description: "true=mute, false=unmute. Omit to leave unchanged." }
      }, required: [] },
      requiresApproval: false
    },
    {
      name: "rc_brightness",
      description: "Get or set display brightness (0.0-1.0). Works on built-in displays.",
      parameters: { type: "object", properties: {
        level: { type: "number", description: "Brightness 0.0-1.0. Omit to just read." }
      }, required: [] },
      requiresApproval: false
    },
    {
      name: "rc_screen_text",
      description: "Read all visible text from the screen using OCR (macOS Vision framework). Useful for reading content from any app.",
      parameters: { type: "object", properties: {
        app: { type: "string", description: "Optional: capture only this app's window" }
      }, required: [] },
      requiresApproval: false
    }
  ]
};
async function safeOsaCall(osa, script, toolName) {
  try {
    return await osa.run(script);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not allowed assistive access") || msg.includes("1002") || msg.includes("assistive")) {
      throw new Error(
        `macOS Accessibility permission required for ${toolName}. Grant access in: System Settings > Privacy & Security > Accessibility. Add Terminal (or the app running Zaraa) to the allowed list.`
      );
    }
    if (msg.includes("not running") || msg.includes("-600")) {
      const appMatch = script.match(/tell application "([^"]+)"/);
      throw new Error(
        `Application "${appMatch?.[1] ?? "unknown"}" is not running. Launch it first with app_launch.`
      );
    }
    throw err;
  }
}
function isCommandUnavailable(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("ENOENT");
}
async function runSystemCommand(osa, command, args) {
  try {
    return await osa.runCommand(command, args);
  } catch (err) {
    if (isCommandUnavailable(err)) {
      return null;
    }
    throw err;
  }
}
function logSystemCommandFailure(context, err) {
  if (isCommandUnavailable(err)) {
    console.debug(`[app-control] ${context}: required system command unavailable in environment`);
    return;
  }
  console.debug(`[app-control] ${context}:`, err instanceof Error ? err.message : err);
}
function unavailableReason() {
  return "tooling unavailable in this environment";
}
function createHandlers(osa) {
  return {
    app_list_running: async () => {
      const result = await osa.run(
        'tell application "System Events" to get name of every process whose background only is false'
      );
      const apps = result.split(", ").sort();
      return { apps, count: apps.length };
    },
    app_launch: async (args) => {
      const app = escapeAppleScript(args.app);
      await osa.run(`tell application "${app}" to activate`);
      return { launched: args.app };
    },
    app_quit: async (args) => {
      const app = escapeAppleScript(args.app);
      await osa.run(`tell application "${app}" to quit`);
      return { quit: args.app };
    },
    app_activate: async (args) => {
      const app = escapeAppleScript(args.app);
      await osa.run(`tell application "${app}" to activate`);
      return { activated: args.app };
    },
    app_script: async (args) => {
      const script = args.script;
      const blocked = [
        /do\s+shell\s+script/i,
        // \s* (not \s+): AppleScript accepts "SystemEvents" with no space,
        // which bypassed a \s+ guard for keystroke/key-code injection.
        /system\s*events.*keystroke/i,
        /system\s*events.*key\s+code/i,
        /POSIX\s+file/i,
        /open\s+for\s+access/i,
        /write\s+to\s+file/i,
        /read\s+file/i,
        /«class\s/,
        /run\s+script/i
      ];
      for (const pattern of blocked) {
        if (pattern.test(script)) {
          return { error: `Blocked: script contains forbidden pattern (${pattern.source})` };
        }
      }
      const result = await osa.run(script);
      return { result };
    },
    app_get_windows: async (args) => {
      const app = escapeAppleScript(args.app);
      const result = await safeOsaCall(
        osa,
        `tell application "System Events" to tell process "${app}" to get {name, position, size} of every window`,
        "app_get_windows"
      );
      return { windows: result };
    },
    app_menu_action: async (args) => {
      const app = escapeAppleScript(args.app);
      const menuPath = args.menuPath.split(" > ").map((s) => s.trim());
      if (menuPath.length < 2) {
        throw new Error("menuPath must have at least 2 levels (e.g. 'File > Save')");
      }
      let script = `tell application "System Events" to tell process "${app}"
`;
      script += `  click menu item "${escapeAppleScript(menuPath[menuPath.length - 1])}" of `;
      for (let i = menuPath.length - 2; i >= 1; i--) {
        script += `menu "${escapeAppleScript(menuPath[i])}" of menu item "${escapeAppleScript(menuPath[i])}" of `;
      }
      script += `menu "${escapeAppleScript(menuPath[0])}" of menu bar 1`;
      script += "\nend tell";
      await osa.run(`tell application "${app}" to activate`);
      await new Promise((r) => setTimeout(r, 200));
      await safeOsaCall(osa, script, "app_menu_action");
      return { clicked: args.menuPath };
    },
    app_type_text: async (args) => {
      const text = escapeAppleScript(args.text);
      await safeOsaCall(
        osa,
        `tell application "System Events" to keystroke "${text}"`,
        "app_type_text"
      );
      return { typed: args.text.length + " characters" };
    },
    app_keystroke: async (args) => {
      const key = escapeAppleScript(args.key);
      const modifiers = args.modifiers ?? [];
      let script;
      if (modifiers.length > 0) {
        const modStr = modifiers.map((m) => `${m} down`).join(", ");
        script = `tell application "System Events" to keystroke "${key}" using {${modStr}}`;
      } else {
        script = `tell application "System Events" to keystroke "${key}"`;
      }
      await safeOsaCall(osa, script, "app_keystroke");
      return { sent: `${modifiers.join("+")}${modifiers.length ? "+" : ""}${args.key}` };
    },
    app_open_url: async (args) => {
      const rawUrl = args.url;
      let parsedScheme;
      try {
        parsedScheme = new URL(rawUrl).protocol;
      } catch {
        return { error: `Blocked: invalid URL "${rawUrl}"` };
      }
      if (parsedScheme !== "http:" && parsedScheme !== "https:") {
        return { error: `Blocked URL scheme: ${parsedScheme}` };
      }
      const url = escapeAppleScript(rawUrl);
      await osa.run(`open location "${url}"`);
      return { opened: rawUrl };
    },
    // ── Remote Control handlers ────────────────────────────────────
    rc_screenshot: async (args) => {
      const mode = args.mode || "fullscreen";
      const ts = Date.now();
      const filePath = `/tmp/zaraa-screenshot-${ts}.png`;
      if (mode === "window" && args.app) {
        const app = escapeAppleScript(args.app);
        await osa.run(`tell application "${app}" to activate`);
        await new Promise((r) => setTimeout(r, 300));
        try {
          const wid = await osa.run(
            `tell application "System Events" to tell process "${app}" to get id of window 1`
          );
          await osa.runCommand(SCREEN_CAPTURE_COMMAND, ["-x", "-l", wid, filePath]);
        } catch (err) {
          console.debug("[app-control] window ID capture failed, using interactive:", err instanceof Error ? err.message : err);
          await osa.runCommand(SCREEN_CAPTURE_COMMAND, ["-x", "-w", filePath]);
        }
      } else {
        await osa.runCommand(SCREEN_CAPTURE_COMMAND, ["-x", filePath]);
      }
      return { path: filePath, mode, app: args.app ?? null };
    },
    rc_clipboard_read: async () => {
      const content = await osa.run("the clipboard");
      return { content };
    },
    rc_clipboard_write: async (args) => {
      const text = escapeAppleScript(args.text);
      await osa.run(`set the clipboard to "${text}"`);
      return { written: `${args.text.length} characters` };
    },
    rc_system_info: async (args) => {
      const cats = args.categories ?? ["all"];
      const wantAll = cats.includes("all");
      const info = {};
      if (wantAll || cats.includes("cpu")) {
        try {
          const raw = await runSystemCommand(osa, "sysctl", ["-n", "hw.ncpu"]);
          const load = await runSystemCommand(osa, "sysctl", ["-n", "vm.loadavg"]);
          if (raw === null || load === null) {
            info.cpu = unavailableReason();
          } else {
            info.cpu = { cores: parseInt(raw), loadAvg: load.replace(/[{}]/g, "").trim() };
          }
        } catch (err) {
          logSystemCommandFailure("cpu info failed", err);
          info.cpu = "unavailable";
        }
      }
      if (wantAll || cats.includes("memory")) {
        try {
          const raw = await runSystemCommand(osa, "vm_stat", []);
          if (raw === null) {
            info.memory = unavailableReason();
          } else {
            const pageSize = 16384;
            const match = (key) => {
              const m = raw.match(new RegExp(`${key}:\\s+(\\d+)`));
              return m ? parseInt(m[1]) * pageSize : 0;
            };
            const free = match("Pages free");
            const active = match("Pages active");
            const inactive = match("Pages inactive");
            const wired = match("Pages wired down");
            const totalRaw = await runSystemCommand(osa, "sysctl", ["-n", "hw.memsize"]);
            if (totalRaw === null) {
              info.memory = unavailableReason();
            } else {
              const totalBytes = parseInt(totalRaw);
              const usedBytes = active + wired;
              info.memory = {
                totalGB: (totalBytes / 1e9).toFixed(1),
                usedGB: (usedBytes / 1e9).toFixed(1),
                freeGB: ((free + inactive) / 1e9).toFixed(1)
              };
            }
          }
        } catch (err) {
          logSystemCommandFailure("memory info failed", err);
          info.memory = "unavailable";
        }
      }
      if (wantAll || cats.includes("disk")) {
        try {
          const raw = await runSystemCommand(osa, "df", ["-H", "/"]);
          if (raw === null) {
            info.disk = unavailableReason();
          } else {
            const lines = raw.split("\n");
            if (lines.length >= 2) {
              const parts = lines[1].split(/\s+/);
              info.disk = { total: parts[1], used: parts[2], available: parts[3], usePct: parts[4] };
            }
          }
        } catch (err) {
          logSystemCommandFailure("disk info failed", err);
          info.disk = "unavailable";
        }
      }
      if (wantAll || cats.includes("battery")) {
        try {
          const raw = await runSystemCommand(osa, "pmset", ["-g", "batt"]);
          if (raw === null) {
            info.battery = unavailableReason();
          } else {
            const pctMatch = raw.match(/(\d+)%/);
            const stateMatch = raw.match(/'([^']+)'/);
            info.battery = {
              percent: pctMatch ? parseInt(pctMatch[1]) : null,
              state: stateMatch ? stateMatch[1] : "unknown",
              raw: raw.split("\n").slice(1).join(" ").trim()
            };
          }
        } catch (err) {
          logSystemCommandFailure("battery info failed", err);
          info.battery = "unavailable (desktop Mac)";
        }
      }
      if (wantAll || cats.includes("network")) {
        try {
          const raw = await runSystemCommand(osa, "ifconfig", ["en0"]);
          if (raw === null) {
            info.network = unavailableReason();
          } else {
            const ipMatch = raw.match(/inet (\d+\.\d+\.\d+\.\d+)/);
            let wifi = "unknown";
            try {
              const wifiRaw = await runSystemCommand(osa, "networksetup", ["-getairportnetwork", "en0"]);
              if (wifiRaw) {
                wifi = wifiRaw;
              }
            } catch (err) {
              console.debug("[app-control] wifi detection failed (likely wired):", err instanceof Error ? err.message : err);
            }
            info.network = { ip: ipMatch?.[1] ?? "no IP", interface: "en0", wifi: wifi.replace("Current Wi-Fi Network: ", "") };
          }
        } catch (err) {
          logSystemCommandFailure("network info failed", err);
          info.network = "unavailable";
        }
      }
      return info;
    },
    rc_notify: async (args) => {
      const titleRaw = args.title;
      const messageRaw = args.message;
      if (titleRaw == null || String(titleRaw).trim() === "") {
        throw new Error("title is required");
      }
      if (messageRaw == null || String(messageRaw).trim() === "") {
        throw new Error("message is required");
      }
      const title = escapeAppleScript(String(titleRaw));
      const message = escapeAppleScript(String(messageRaw));
      const soundRaw = args.sound;
      const sound = typeof soundRaw === "string" && soundRaw.trim() !== "" ? soundRaw : "default";
      await osa.run(`display notification "${message}" with title "${title}" sound name "${escapeAppleScript(sound)}"`);
      return { sent: true, title: String(titleRaw) };
    },
    rc_open_file: async (args) => {
      const filePath = args.path;
      const { existsSync } = await import("fs");
      if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
      if (args.app) {
        await osa.runCommand("open", ["-a", args.app, filePath]);
      } else {
        await osa.runCommand("open", [filePath]);
      }
      return { opened: filePath, app: args.app ?? "default" };
    },
    rc_processes: async (args) => {
      const raw = await runSystemCommand(osa, "ps", ["-axo", "pid,pcpu,pmem,comm", "-r"]);
      if (raw === null) {
        return { processes: [], total: 0 };
      }
      const lines = raw.split("\n").slice(1);
      let processes = lines.filter((l) => l.trim()).map((l) => {
        const parts = l.trim().split(/\s+/);
        return { pid: parseInt(parts[0]), cpu: parseFloat(parts[1]), mem: parseFloat(parts[2]), name: parts.slice(3).join(" ") };
      });
      const search = args.search;
      if (search) {
        const s = search.toLowerCase();
        processes = processes.filter((p) => p.name.toLowerCase().includes(s));
      }
      const limit = Math.min(args.limit || 20, 100);
      return { processes: processes.slice(0, limit), total: processes.length };
    },
    rc_volume: async (args) => {
      if (typeof args.level === "number") {
        const vol = Math.max(0, Math.min(100, Math.round(args.level)));
        await osa.run(`set volume output volume ${vol}`);
      }
      if (typeof args.mute === "boolean") {
        await osa.run(`set volume output muted ${args.mute}`);
      }
      const raw = await osa.run("get volume settings");
      const outVol = raw.match(/output volume:(\d+)/)?.[1];
      const muted = raw.match(/output muted:(true|false)/)?.[1];
      return { volume: outVol ? parseInt(outVol) : null, muted: muted === "true", raw };
    },
    rc_brightness: async (args) => {
      if (typeof args.level === "number") {
        const lvl = Math.max(0, Math.min(1, args.level));
        try {
          await osa.runCommand("brightness", [lvl.toString()]);
        } catch (err) {
          console.debug("[app-control] brightness CLI failed, using keyboard fallback:", err instanceof Error ? err.message : err);
          const steps = Math.round(lvl * 16);
          for (let i = 0; i < 16; i++) await osa.run('tell application "System Events" to key code 145');
          for (let i = 0; i < steps; i++) await osa.run('tell application "System Events" to key code 144');
        }
      }
      let brightness = "unknown";
      try {
        brightness = parseFloat(await osa.runCommand("brightness", ["-l"]));
      } catch (err) {
        console.debug("[app-control] brightness read via CLI failed:", err instanceof Error ? err.message : err);
        try {
          const raw = await osa.runCommand("ioreg", ["-c", "AppleBacklightDisplay"]);
          const m = raw.match(/"brightness"=(\d+)/);
          if (m) brightness = parseInt(m[1]) / 1024;
        } catch (err2) {
          console.debug("[app-control] brightness read via ioreg failed:", err2 instanceof Error ? err2.message : err2);
        }
      }
      return { brightness, changed: typeof args.level === "number" };
    },
    rc_screen_text: async (args) => {
      const ts = Date.now();
      const filePath = `/tmp/zaraa-ocr-${ts}.png`;
      if (args.app) {
        const app = escapeAppleScript(args.app);
        await osa.run(`tell application "${app}" to activate`);
        await new Promise((r) => setTimeout(r, 300));
        await osa.runCommand(SCREEN_CAPTURE_COMMAND, ["-x", filePath]);
      } else {
        await osa.runCommand(SCREEN_CAPTURE_COMMAND, ["-x", filePath]);
      }
      const jxa = `
ObjC.import('Vision'); ObjC.import('AppKit');
var img = $.NSImage.alloc.initWithContentsOfFile(${JSON.stringify(filePath)});
var cgRef = img.CGImageForProposedRectContextHints(null, null, null);
var req = $.VNRecognizeTextRequest.alloc.init;
req.recognitionLevel = 1;
var handler = $.VNImageRequestHandler.alloc.initWithCGImageOptions(cgRef, null);
handler.performRequestsError([req], null);
var res = req.results;
var t = '';
for (var i = 0; i < res.count; i++) { t += res.objectAtIndex(i).topCandidates(1).objectAtIndex(0).string.js + '\\n'; }
t;`.replace(/\n/g, " ");
      let text = "";
      try {
        text = await osa.runJxa(jxa);
      } catch (err) {
        try {
          const { unlinkSync } = await import("fs");
          unlinkSync(filePath);
        } catch {
        }
        return { error: `OCR failed: ${err instanceof Error ? err.message : String(err)}. Ensure Screen Recording permission is granted.`, text: "" };
      }
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(filePath);
      } catch {
      }
      return { text: text.trim(), characters: text.trim().length };
    }
  };
}
export {
  createHandlers,
  manifest
};
