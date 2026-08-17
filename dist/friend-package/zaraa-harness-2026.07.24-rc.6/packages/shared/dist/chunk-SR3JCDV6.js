// src/designer-artifacts.ts
var DEFAULT_ARTIFACT_TYPE = "text/html";
function normalizeDesignerArtifactType(type) {
  const normalized = type?.trim().toLowerCase().split(";", 1)[0]?.trim();
  return normalized && normalized.length > 0 ? normalized : DEFAULT_ARTIFACT_TYPE;
}
function inferDesignerArtifactKind(mimeType) {
  const normalized = normalizeDesignerArtifactType(mimeType);
  if (normalized === "text/html" || normalized === "application/xhtml+xml") {
    return "html";
  }
  if (normalized === "text/markdown" || normalized === "text/x-markdown") {
    return "markdown";
  }
  if (normalized === "image/svg+xml") {
    return "svg";
  }
  if (normalized === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || normalized === "application/vnd.ms-powerpoint" || normalized === "application/vnd.zaraa.deck+html") {
    return "deck";
  }
  if (normalized === "application/vnd.zaraa.mobile" || normalized === "application/vnd.zaraa.mobile+html" || normalized.startsWith("application/vnd.apple.")) {
    return "mobile";
  }
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  return "unknown";
}
function extractDesignerArtifacts(input) {
  const artifacts = [];
  const artifactPattern = /<artifact\b([^>]*)>([\s\S]*?)<\/artifact>/gi;
  let match = artifactPattern.exec(input);
  while (match !== null) {
    const index = artifacts.length + 1;
    const attributes = parseArtifactAttributes(match[1] ?? "");
    const warnings = [];
    const mimeType = normalizeDesignerArtifactType(attributes.type);
    const kind = inferDesignerArtifactKind(mimeType);
    const identifier = attributes.identifier?.trim() || `artifact-${index}`;
    const title = attributes.title?.trim() || "Untitled artifact";
    if (!attributes.identifier?.trim()) {
      warnings.push("Missing artifact identifier; generated a fallback identifier.");
    }
    if (!attributes.title?.trim()) {
      warnings.push("Missing artifact title; generated a fallback title.");
    }
    if (kind === "unknown") {
      warnings.push(`Unsupported artifact type: ${mimeType}.`);
    }
    artifacts.push({
      identifier,
      mimeType,
      kind,
      title,
      content: match[2] ?? "",
      rawSource: match[0],
      warnings
    });
    match = artifactPattern.exec(input);
  }
  return artifacts;
}
function lintDesignerHtmlArtifact(html) {
  const issues = [];
  const linkTags = findHtmlTags(html, "link");
  const cssUrls = findRemoteCssUrls(html);
  addIssueIf(issues, !/^\s*<!doctype\s+html\b/i.test(html), {
    code: "missing-doctype",
    severity: "error",
    message: "HTML artifacts must include an HTML doctype."
  });
  addIssueIf(issues, !/<html\b/i.test(html), {
    code: "missing-html",
    severity: "error",
    message: "HTML artifacts must include an html element."
  });
  addIssueIf(issues, !/<head\b/i.test(html), {
    code: "missing-head",
    severity: "error",
    message: "HTML artifacts must include a head element."
  });
  addIssueIf(issues, !/<title\b[^>]*>\s*[^<\s][\s\S]*?<\/title>/i.test(html), {
    code: "missing-title",
    severity: "error",
    message: "HTML artifacts must include a non-empty title."
  });
  addIssueIf(issues, !/<body\b/i.test(html), {
    code: "missing-body",
    severity: "error",
    message: "HTML artifacts must include a body element."
  });
  addIssueIf(issues, !hasViewportMeta(html), {
    code: "missing-viewport",
    severity: "warning",
    message: "HTML artifacts should include a viewport meta tag."
  });
  addIssueIf(issues, hasRemoteTagAttribute(html, "script", "src"), {
    code: "remote-script",
    severity: "warning",
    message: "Remote scripts are blocked in export-ready HTML artifacts."
  });
  addIssueIf(issues, hasRemoteFontOrStylesheet(html, linkTags, cssUrls), {
    code: "remote-font-or-stylesheet",
    severity: "warning",
    message: "Remote fonts and stylesheets should be bundled before export."
  });
  addIssueIf(issues, hasRemoteImage(html, cssUrls), {
    code: "remote-image",
    severity: "warning",
    message: "Remote images should be bundled before export."
  });
  addIssueIf(issues, hasRemoteLink(html, linkTags), {
    code: "remote-link",
    severity: "warning",
    message: "Remote links should be reviewed before export."
  });
  addIssueIf(issues, /<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), {
    code: "inline-script-blocked",
    severity: "warning",
    message: "Inline script blocks are blocked in export-ready HTML artifacts."
  });
  if (issues.some((issue) => issue.severity === "error")) {
    return { status: "fail", issues };
  }
  if (issues.length > 0) {
    return { status: "warning", issues };
  }
  return { status: "pass", issues };
}
function parseArtifactAttributes(source) {
  const attributes = {};
  const attributePattern = /\b([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match = attributePattern.exec(source);
  while (match !== null) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
    match = attributePattern.exec(source);
  }
  return attributes;
}
function addIssueIf(issues, condition, issue) {
  if (condition) {
    issues.push(issue);
  }
}
function hasRemoteFontOrStylesheet(html, linkTags = findHtmlTags(html, "link"), cssUrls = findRemoteCssUrls(html)) {
  return linkTags.some((attributes) => {
    const href = getHtmlAttribute(attributes, "href");
    const rel = getHtmlAttribute(attributes, "rel");
    return isRemoteUrl(href) && hasStylesheetRel(rel);
  }) || /@import\s+(?:url\()?\s*['"]?https?:\/\//i.test(html) || hasRemoteCssFontUrl(cssUrls);
}
function hasRemoteLink(html, linkTags = findHtmlTags(html, "link")) {
  return hasRemoteTagAttribute(html, "a", "href") || linkTags.some((attributes) => {
    const href = getHtmlAttribute(attributes, "href");
    const rel = getHtmlAttribute(attributes, "rel");
    return isRemoteUrl(href) && !hasStylesheetRel(rel);
  });
}
function hasViewportMeta(html) {
  return findHtmlTags(html, "meta").some(
    (attributes) => getHtmlAttribute(attributes, "name")?.toLowerCase() === "viewport"
  );
}
function hasRemoteImage(html, cssUrls = findRemoteCssUrls(html)) {
  return findHtmlTags(html, "img").some((attributes) => {
    const src = getHtmlAttribute(attributes, "src");
    const srcset = getHtmlAttribute(attributes, "srcset");
    return isRemoteUrl(src) || hasRemoteSrcset(srcset);
  }) || hasRemoteCssImageUrl(cssUrls);
}
function hasRemoteTagAttribute(html, tagName, attributeName) {
  return findHtmlTags(html, tagName).some(
    (attributes) => isRemoteUrl(getHtmlAttribute(attributes, attributeName))
  );
}
function findHtmlTags(html, tagName) {
  const tagPattern = new RegExp(`<${tagName}\\b([^>]*)>`, "gi");
  const matches = [];
  let match = tagPattern.exec(html);
  while (match !== null) {
    matches.push(match[1] ?? "");
    match = tagPattern.exec(html);
  }
  return matches;
}
function getHtmlAttribute(source, attributeName) {
  const attributePattern = /\b([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match = attributePattern.exec(source);
  while (match !== null) {
    if (match[1].toLowerCase() === attributeName.toLowerCase()) {
      return match[2] ?? match[3] ?? match[4] ?? "";
    }
    match = attributePattern.exec(source);
  }
  return void 0;
}
function isRemoteUrl(value) {
  return /^https?:\/\//i.test(value ?? "");
}
function hasRemoteSrcset(value) {
  return (value ?? "").split(",").some((candidate) => isRemoteUrl(candidate.trim().split(/\s+/, 1)[0]));
}
function hasRemoteCssImageUrl(cssUrls) {
  return cssUrls.some((url) => !isFontUrl(url));
}
function hasRemoteCssFontUrl(cssUrls) {
  return cssUrls.some((url) => isFontUrl(url));
}
function findRemoteCssUrls(html) {
  const cssUrlPattern = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^'")\s]+))\s*\)/gi;
  const urls = [];
  let match = cssUrlPattern.exec(html);
  while (match !== null) {
    const url = match[1] ?? match[2] ?? match[3] ?? "";
    if (isRemoteUrl(url)) {
      urls.push(url);
    }
    match = cssUrlPattern.exec(html);
  }
  return urls;
}
function isFontUrl(url) {
  return /\.(?:woff2?|ttf|otf|eot)(?:[?#].*)?$/i.test(url);
}
function hasStylesheetRel(value) {
  const relTokens = value?.toLowerCase().split(/\s+/) ?? [];
  return relTokens.some(
    (token) => ["stylesheet", "preload", "preconnect", "dns-prefetch"].includes(token)
  );
}

export {
  normalizeDesignerArtifactType,
  inferDesignerArtifactKind,
  extractDesignerArtifacts,
  lintDesignerHtmlArtifact
};
