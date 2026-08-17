// src/cli-anything/cli-anything-tools.ts
var manifest = {
  name: "cli-anything",
  version: "1.0.0",
  type: "tool",
  minZone: "trusted",
  capabilities: ["cli-anything"],
  trust: "community",
  tools: [
    {
      name: "cli_discover",
      description: "Discover installed CLI-Anything harnesses (GIMP, Blender, LibreOffice, etc.). Returns a list of available software that can be controlled via CLI commands. Run this first before using cli_run. Results are cached for 5 minutes.",
      parameters: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Force re-scan PATH, bypassing the 5-minute cache (default: false)"
          }
        },
        required: []
      },
      requiresApproval: false
    },
    {
      name: "cli_run",
      description: "Execute a CLI-Anything command on a discovered software harness. The command is run with --json output by default. Examples: cli_run({software: 'gimp', command: 'project new -w 1920 -h 1080'}), cli_run({software: 'blender', command: 'scene list'}), cli_run({software: 'libreoffice', command: 'export pdf --input doc.odt --output doc.pdf'}).",
      parameters: {
        type: "object",
        properties: {
          software: {
            type: "string",
            description: "Software name from cli_discover (e.g. 'gimp', 'blender', 'libreoffice')"
          },
          command: {
            type: "string",
            description: "The CLI-Anything command and arguments as a single string (e.g. 'project new -w 1920 -h 1080', 'layer add --name Background'). Do NOT include the binary name or --json flag \u2014 those are added automatically."
          },
          json: {
            type: "boolean",
            description: "Whether to request JSON output (default: true). Set false for raw text output."
          }
        },
        required: ["software", "command"]
      },
      requiresApproval: true
    },
    {
      name: "cli_help",
      description: "Get help text for a CLI-Anything harness or a specific command group. Use to discover available commands before running them.",
      parameters: {
        type: "object",
        properties: {
          software: {
            type: "string",
            description: "Software name (e.g. 'gimp', 'blender')"
          },
          command: {
            type: "string",
            description: "Optional command group to get help for (e.g. 'project', 'layer', 'export'). Omit to get top-level help."
          }
        },
        required: ["software"]
      },
      requiresApproval: false
    }
  ]
};
function createCliAnythingHandlers(deps) {
  const { bridge } = deps;
  return {
    cli_discover: async (args) => {
      const force = args.force ?? false;
      const harnesses = await bridge.discover(force);
      if (harnesses.length === 0) {
        return JSON.stringify({
          message: "No CLI-Anything harnesses found. Install them with: pip install cli-anything-<software> (e.g. pip install cli-anything-gimp). The target application must also be installed.",
          harnesses: []
        });
      }
      return JSON.stringify({
        count: harnesses.length,
        harnesses: harnesses.map((h) => ({
          software: h.software,
          binary: h.binary,
          version: h.version ?? "unknown"
        })),
        hint: "Use cli_help({software: '<name>'}) to see available commands, then cli_run to execute them."
      });
    },
    cli_run: async (args) => {
      const software = args.software;
      const command = args.command;
      const json = args.json ?? true;
      if (!software) throw new Error("software is required");
      if (!command) throw new Error("command is required");
      const cmdArgs = splitCommandArgs(command);
      const result = await bridge.run(software, cmdArgs, json);
      if (!result.ok) {
        return JSON.stringify({
          ok: false,
          error: result.stderr || `Command failed with exit code ${result.exitCode}`,
          exitCode: result.exitCode,
          durationMs: result.durationMs
        });
      }
      return JSON.stringify({
        ok: true,
        data: result.data ?? result.stdout,
        durationMs: result.durationMs
      });
    },
    cli_help: async (args) => {
      const software = args.software;
      const command = args.command;
      if (!software) throw new Error("software is required");
      const helpText = await bridge.help(software, command);
      return helpText;
    }
  };
}
function splitCommandArgs(command) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "	") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

export {
  manifest,
  createCliAnythingHandlers
};
