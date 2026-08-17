// src/messaging/imessage-formatter.ts
function formatForIMessage(text) {
  let result = text;
  result = result.replace(/```[\w]*\n([\s\S]*?)```/g, (_match, code) => {
    return code.split("\n").map((line) => `  ${line}`).join("\n");
  });
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading) => heading.toUpperCase());
  result = result.replace(/^-{3,}$/gm, "\u2014");
  result = result.replace(/^\*{3,}$/gm, "\u2014");
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/~~(.+?)~~/g, "$1");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  result = result.replace(/^>\s+(.+)$/gm, '"$1"');
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&quot;/g, '"');
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/&nbsp;/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

export {
  formatForIMessage
};
