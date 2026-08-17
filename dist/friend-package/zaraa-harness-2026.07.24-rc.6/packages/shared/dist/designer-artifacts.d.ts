type DesignerArtifactKind = "html" | "markdown" | "svg" | "deck" | "mobile" | "image" | "video" | "unknown";
type DesignerArtifactLintStatus = "pass" | "warning" | "fail";
interface ParsedDesignerArtifact {
    identifier: string;
    mimeType: string;
    kind: DesignerArtifactKind;
    title: string;
    content: string;
    rawSource: string;
    warnings: string[];
}
interface DesignerArtifactLintIssue {
    code: "missing-doctype" | "missing-html" | "missing-head" | "missing-title" | "missing-body" | "missing-viewport" | "remote-script" | "remote-font-or-stylesheet" | "remote-image" | "remote-link" | "inline-script-blocked";
    severity: "warning" | "error";
    message: string;
}
interface DesignerArtifactLintSummary {
    status: DesignerArtifactLintStatus;
    issues: DesignerArtifactLintIssue[];
}
declare function normalizeDesignerArtifactType(type: string | undefined): string;
declare function inferDesignerArtifactKind(mimeType: string): DesignerArtifactKind;
declare function extractDesignerArtifacts(input: string): ParsedDesignerArtifact[];
declare function lintDesignerHtmlArtifact(html: string): DesignerArtifactLintSummary;

export { type DesignerArtifactKind, type DesignerArtifactLintIssue, type DesignerArtifactLintStatus, type DesignerArtifactLintSummary, type ParsedDesignerArtifact, extractDesignerArtifacts, inferDesignerArtifactKind, lintDesignerHtmlArtifact, normalizeDesignerArtifactType };
