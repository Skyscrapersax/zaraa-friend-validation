// src/handlers.ts
function createShellHandlers(sandbox) {
  return {
    async shell_exec({ command, args = [] }) {
      let executable = command;
      let execArgs = args;
      if (execArgs.length === 0 && command.includes(" ")) {
        const parts = command.split(/\s+/);
        executable = parts[0];
        execArgs = parts.slice(1);
      }
      const result = await sandbox.execute(executable, execArgs);
      let output = result.stdout;
      if (result.stderr) {
        output += (output ? "\n" : "") + `[stderr] ${result.stderr}`;
      }
      if (result.exitCode !== 0) {
        output += `
[exit code: ${result.exitCode}]`;
      }
      return output || "(no output)";
    }
  };
}

// src/index.ts
var manifest = {
  name: "shell",
  version: "0.1.0",
  type: "tool",
  minZone: "guarded",
  capabilities: ["shell.exec"],
  trust: "core",
  tools: [
    {
      name: "shell_exec",
      description: "Execute a shell command. Pass the full command as a string (e.g., 'ls -la /tmp'). Pipes are not supported \u2014 use separate calls instead.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run (e.g., 'git status', 'ls -la /tmp')" },
          args: { type: "array", items: { type: "string" }, description: "Optional separate args array. If omitted, command string is auto-split." }
        },
        required: ["command"]
      },
      requiresApproval: true
    }
  ]
};
export {
  createShellHandlers,
  manifest
};
