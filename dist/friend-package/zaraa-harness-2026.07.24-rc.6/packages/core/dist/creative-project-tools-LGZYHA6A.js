import "./chunk-R5U7XKVJ.js";

// src/creative/creative-project-tools.ts
function requiredString(args, key) {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value) throw new Error(`${key} is required.`);
  return value;
}
function optionalString(args, key) {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  return value || null;
}
function projectId(args) {
  const id = optionalString(args, "project_id") ?? optionalString(args, "projectId") ?? optionalString(args, "id");
  if (!id) throw new Error("project_id is required.");
  return id;
}
function normalizeMedium(value) {
  if (value === "design" || value === "image" || value === "video" || value === "music" || value === "multi") {
    return value;
  }
  throw new Error(`Unsupported creative medium "${value}".`);
}
function normalizeStatus(value) {
  if (value === "source-gated" || value === "draft" || value === "generated" || value === "reviewed" || value === "released") {
    return value;
  }
  throw new Error(`Unsupported creative project status "${value}".`);
}
function normalizeVerdict(value) {
  if (value === "ship" || value === "revise" || value === "reject") return value;
  throw new Error(`Unsupported creative critique verdict "${value}".`);
}
function scoreValue(scores, key, alias) {
  const value = scores[key] ?? (alias ? scores[alias] : void 0);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`scores.${key} is required.`);
  }
  if (value < 1 || value > 5) throw new Error(`scores.${key} must be between 1 and 5.`);
  return value;
}
function normalizeScores(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scores is required.");
  }
  const scores = value;
  return {
    source: scoreValue(scores, "source"),
    specificity: scoreValue(scores, "specificity"),
    originality: scoreValue(scores, "originality"),
    craft: scoreValue(scores, "craft"),
    restraint: scoreValue(scores, "restraint"),
    emotionalTruth: scoreValue(scores, "emotionalTruth", "emotional_truth"),
    platformFit: scoreValue(scores, "platformFit", "platform_fit"),
    provenance: scoreValue(scores, "provenance")
  };
}
function resolvePracticeSource(args, store) {
  const id = optionalString(args, "project_id") ?? optionalString(args, "projectId");
  if (id) {
    const snapshot = store.getProject(id);
    if (!snapshot) throw new Error(`Creative project "${id}" was not found.`);
    return {
      projectId: id,
      medium: snapshot.project.medium,
      humanSource: snapshot.project.humanSource,
      audience: snapshot.project.audience,
      form: snapshot.project.form,
      qualityGate: snapshot.project.qualityGate,
      provenanceNotes: snapshot.project.provenanceNotes
    };
  }
  return {
    projectId: null,
    medium: normalizeMedium(requiredString(args, "medium")),
    humanSource: requiredString(args, "human_source"),
    audience: requiredString(args, "audience"),
    form: requiredString(args, "form"),
    qualityGate: requiredString(args, "quality_gate"),
    provenanceNotes: requiredString(args, "provenance_notes")
  };
}
function practiceReferenceFocus(medium) {
  if (medium === "design") {
    return "Study 3-5 strong design references for transferable hierarchy, density, navigation, contrast, accessibility, and interaction decisions.";
  }
  if (medium === "image") {
    return "Study 3-7 image references for transferable composition, material behavior, lighting, crop, legibility, and artifact risks.";
  }
  if (medium === "video") {
    return "Study 3-7 video references for transferable beat structure, camera logic, edit rhythm, motion continuity, lighting, and platform fit.";
  }
  if (medium === "music") {
    return "Study 3-7 music references for transferable form, groove, hook placement, arrangement contrast, mix translation, and silence.";
  }
  return "Study 3-7 cross-medium references for transferable source, structure, constraint, sequence, craft move, and failure mode.";
}
function practiceNonTransferable(medium) {
  if (medium === "design") {
    return "Do not copy brand identity, proprietary UI, copy, product claims, screenshots, or signature visual language.";
  }
  if (medium === "image") {
    return "Do not copy identity, likeness, marks, protected worlds, exact frames, living-artist style, or unclear source assets.";
  }
  if (medium === "video") {
    return "Do not copy identity, likeness, marks, protected worlds, exact shots, living-artist style, copyrighted footage, or unclear source assets.";
  }
  if (medium === "music") {
    return "Do not copy melody, lyric, vocal identity, exact artist style, samples, masters, or uncleared musical fingerprints.";
  }
  return "Do not copy identity, protected marks, assets, lyrics, voice, lived experience, proprietary data, or surface style.";
}
function buildPracticeDrill(source) {
  return {
    mode: "creative_practice_drill",
    mutatesGateway: false,
    order: "source -> form -> technique -> tools",
    projectId: source.projectId,
    medium: source.medium,
    sourceStatus: "ready",
    source: {
      humanSource: source.humanSource,
      audience: source.audience,
      form: source.form,
      qualityGate: source.qualityGate,
      provenanceNotes: source.provenanceNotes
    },
    drill: {
      humanSourcePrompt: `Start from human source: ${source.humanSource}. Audience: ${source.audience}. Form: ${source.form}.`,
      referenceExtraction: practiceReferenceFocus(source.medium),
      nonTransferableElements: practiceNonTransferable(source.medium),
      qualityGate: `Practice against quality gate: ${source.qualityGate}`,
      ledgerOutput: "Log transferable findings with creative_reference_add before generation; after any output, use creative_generation_log for human selection and creative_critique_log for anti-slop review."
    },
    guardrails: [
      "no generation, queue mutation, release, or trading",
      "learn decisions, not costumes",
      "keep human source, quality gate, provenance, and final selection human-owned"
    ]
  };
}
var manifest = {
  name: "creative-projects",
  version: "1.0.0",
  type: "tool",
  minZone: "sandbox",
  capabilities: ["creative-projects"],
  trust: "core",
  tools: [
    {
      name: "creative_practice_drill",
      description: "Build a non-mutating source-led mastercraft practice drill before references, generation, critique, or release.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          medium: { type: "string", enum: ["design", "image", "video", "music", "multi"] },
          human_source: { type: "string" },
          audience: { type: "string" },
          form: { type: "string" },
          quality_gate: { type: "string" },
          provenance_notes: { type: "string" }
        }
      }
    },
    {
      name: "creative_project_create",
      description: "Create a durable source-led creative project before generation or release work.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          medium: { type: "string", enum: ["design", "image", "video", "music", "multi"] },
          human_source: { type: "string" },
          audience: { type: "string" },
          form: { type: "string" },
          quality_gate: { type: "string" },
          provenance_notes: { type: "string" },
          linked_session_id: { type: "string" }
        },
        required: [
          "title",
          "medium",
          "human_source",
          "audience",
          "form",
          "quality_gate",
          "provenance_notes"
        ]
      }
    },
    {
      name: "creative_project_get",
      description: "Get a creative project with source, references, generation history, and critiques.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          id: { type: "string" }
        }
      }
    },
    {
      name: "creative_project_list",
      description: "List creative projects by recency or search term.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" }
        }
      }
    },
    {
      name: "creative_project_update",
      description: "Update source, quality gate, provenance, status, or form for a creative project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          title: { type: "string" },
          medium: { type: "string", enum: ["design", "image", "video", "music", "multi"] },
          status: {
            type: "string",
            enum: ["source-gated", "draft", "generated", "reviewed", "released"]
          },
          human_source: { type: "string" },
          audience: { type: "string" },
          form: { type: "string" },
          quality_gate: { type: "string" },
          provenance_notes: { type: "string" },
          linked_session_id: { type: "string" }
        },
        required: ["project_id"]
      }
    },
    {
      name: "creative_reference_add",
      description: "Add a reference with transferable and non-transferable parts to a creative project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          transferable_pattern: { type: "string" },
          non_transferable_elements: { type: "string" },
          provenance_notes: { type: "string" }
        },
        required: [
          "project_id",
          "title",
          "transferable_pattern",
          "non_transferable_elements",
          "provenance_notes"
        ]
      }
    },
    {
      name: "creative_generation_log",
      description: "Log generated or edited creative output, task id, prompt, human selection, and provenance notes.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          tool: { type: "string" },
          task_id: { type: "string" },
          prompt: { type: "string" },
          output_url: { type: "string" },
          output_text: { type: "string" },
          output_content: { type: "string" },
          human_selection: { type: "string" },
          notes: { type: "string" }
        },
        required: ["project_id", "tool", "prompt"]
      }
    },
    {
      name: "creative_critique_log",
      description: "Log anti-slop critique verdict, 1-5 scores, revision target, and provenance gaps.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          verdict: { type: "string", enum: ["ship", "revise", "reject"] },
          scores: { type: "object" },
          highest_leverage_revision: { type: "string" },
          provenance_gaps: { type: "string" }
        },
        required: [
          "project_id",
          "verdict",
          "scores",
          "highest_leverage_revision",
          "provenance_gaps"
        ]
      }
    }
  ]
};
function createHandlers(store) {
  return {
    creative_practice_drill: async (args) => {
      return buildPracticeDrill(resolvePracticeSource(args, store));
    },
    creative_project_create: async (args) => {
      const project = store.createProject({
        title: requiredString(args, "title"),
        medium: normalizeMedium(requiredString(args, "medium")),
        humanSource: requiredString(args, "human_source"),
        audience: requiredString(args, "audience"),
        form: requiredString(args, "form"),
        qualityGate: requiredString(args, "quality_gate"),
        provenanceNotes: requiredString(args, "provenance_notes"),
        linkedSessionId: optionalString(args, "linked_session_id")
      });
      return store.getProject(project.id);
    },
    creative_project_get: async (args) => {
      const id = projectId(args);
      return store.getProject(id) ?? { found: false, project_id: id };
    },
    creative_project_list: async (args = {}) => {
      return store.listProjects({
        search: optionalString(args, "search") ?? void 0,
        limit: typeof args.limit === "number" ? args.limit : void 0,
        offset: typeof args.offset === "number" ? args.offset : void 0
      });
    },
    creative_project_update: async (args) => {
      const updated = store.updateProject(projectId(args), {
        ...typeof args.title === "string" ? { title: args.title.trim() } : {},
        ...typeof args.medium === "string" ? { medium: normalizeMedium(args.medium.trim()) } : {},
        ...typeof args.status === "string" ? { status: normalizeStatus(args.status.trim()) } : {},
        ...typeof args.human_source === "string" ? { humanSource: args.human_source.trim() } : {},
        ...typeof args.audience === "string" ? { audience: args.audience.trim() } : {},
        ...typeof args.form === "string" ? { form: args.form.trim() } : {},
        ...typeof args.quality_gate === "string" ? { qualityGate: args.quality_gate.trim() } : {},
        ...typeof args.provenance_notes === "string" ? { provenanceNotes: args.provenance_notes.trim() } : {},
        ...typeof args.linked_session_id === "string" ? { linkedSessionId: args.linked_session_id.trim() } : {}
      });
      return updated ?? { found: false, project_id: projectId(args) };
    },
    creative_reference_add: async (args) => {
      return store.addReference(projectId(args), {
        title: requiredString(args, "title"),
        url: optionalString(args, "url"),
        transferablePattern: requiredString(args, "transferable_pattern"),
        nonTransferableElements: requiredString(args, "non_transferable_elements"),
        provenanceNotes: requiredString(args, "provenance_notes")
      });
    },
    creative_generation_log: async (args) => {
      return store.logGeneration(projectId(args), {
        tool: requiredString(args, "tool"),
        taskId: optionalString(args, "task_id"),
        prompt: requiredString(args, "prompt"),
        outputUrl: optionalString(args, "output_url"),
        outputContent: optionalString(args, "output_text") ?? optionalString(args, "output_content"),
        humanSelection: optionalString(args, "human_selection"),
        notes: optionalString(args, "notes")
      });
    },
    creative_critique_log: async (args) => {
      return store.logCritique(projectId(args), {
        verdict: normalizeVerdict(requiredString(args, "verdict")),
        scores: normalizeScores(args.scores),
        highestLeverageRevision: requiredString(args, "highest_leverage_revision"),
        provenanceGaps: requiredString(args, "provenance_gaps")
      });
    }
  };
}
export {
  createHandlers,
  manifest
};
