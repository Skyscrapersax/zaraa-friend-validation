// src/handlers.ts
var IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|tiff?)$/i;
function isBinaryContent(content) {
  const probe = content.slice(0, 2048);
  if (probe.length === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < probe.length; i++) {
    const c = probe.charCodeAt(i);
    if (c < 9 || c === 65533 || c > 13 && c < 32) suspicious++;
  }
  return suspicious / probe.length > 0.05;
}
function createFileHandlers(sandbox) {
  return {
    async file_read({ path, numbered }) {
      const content = await sandbox.read(path);
      if (isBinaryContent(content)) {
        const visionHint = IMAGE_EXT_RE.test(path) ? " This is an image \u2014 use vision_analyze to inspect its content." : "";
        return `[binary file: ${path} (${content.length} bytes decoded) \u2014 content is not readable as text.${visionHint}]`;
      }
      if (numbered) {
        return content.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n");
      }
      return content;
    },
    async file_write({ path, content }) {
      await sandbox.write(path, content);
      return `Written ${content.length} bytes to ${path}`;
    },
    async file_list({ path }) {
      const entries = await sandbox.list(path);
      return entries.join("\n");
    }
  };
}

// src/index.ts
var manifest = {
  name: "files",
  version: "0.1.0",
  type: "tool",
  minZone: "sandbox",
  capabilities: ["file.read"],
  trust: "core",
  tools: [
    {
      name: "file_read",
      description: "Read the contents of a file. Set numbered=true when you need to cite path:line locations \u2014 each line is prefixed with its line number.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          numbered: {
            type: "boolean",
            description: "Prefix each line with its 1-based line number (use when citing file:line locations)"
          }
        },
        required: ["path"]
      }
    },
    {
      name: "file_write",
      description: "Write content to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      },
      requiresApproval: true
    },
    {
      name: "file_list",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  ]
};
export {
  createFileHandlers,
  manifest
};
