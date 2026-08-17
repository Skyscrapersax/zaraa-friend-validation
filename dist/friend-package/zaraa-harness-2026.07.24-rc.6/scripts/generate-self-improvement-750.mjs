#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_DIR = join(process.cwd(), "docs", "runbooks");
const JSON_PATH = join(OUTPUT_DIR, "zaraa-self-improvement-750.json");
const MD_PATH = join(OUTPUT_DIR, "zaraa-self-improvement-750-prompt-set.md");

function focus(title, gap, artifact, metric, priority = "normal", zone) {
	return { title, gap, artifact, metric, priority, zone };
}

const PATCH_WAVES = [
	{
		id: "patch-01",
		number: 1,
		label: "Audit & Baseline",
		directive:
			"audit the current state, expose the weakest link, and establish the first hard baseline",
	},
	{
		id: "patch-02",
		number: 2,
		label: "Repair & Simplify",
		directive:
			"land the leanest durable fix, remove unnecessary complexity, and reduce repeat failure",
	},
	{
		id: "patch-03",
		number: 3,
		label: "Automate & Guardrail",
		directive:
			"automate the repeatable part, add safety rails, and make the better path the default",
	},
	{
		id: "patch-04",
		number: 4,
		label: "Stress & Adapt",
		directive:
			"stress the system with ugly edge cases, measure how it bends, and harden the recovery path",
	},
	{
		id: "patch-05",
		number: 5,
		label: "Teach & Compound",
		directive:
			"distill the lesson into reusable procedures, teach future-Zaraa, and name the next compounding move",
	},
];

const TASK_CREATION_CLAIM_GUARD =
	"Do not say a follow-up task was queued, created, scheduled, submitted, or opened unless you actually call `task_create` or `task_plan` in this run.";
const NEXT_PATCH_CANDIDATE_GUARD =
	"If you only identify the next move, call it `Next follow-on patch` or `Next patch candidate`; do not call it queued.";
const NO_TASK_CREATION_GUARD =
	"Do not call `task_create` or `task_plan` inside this self-improvement task unless the operator explicitly requested task generation outside this prompt.";
const MEASUREMENT_EVIDENCE_GUARD =
	"Never invent numeric baselines, rates, latencies, percentages, or throughput claims. If the metric was not measured with a tool or exact source in this run, write `not measured yet` and name the first measurement to collect.";
const SELF_IMPROVEMENT_HANDOFF_GUARD =
	"End with explicit handoff labels: `Single highest-leverage weakness`, `Smallest durable improvement`, `Measurable signal`, and `Next follow-on patch`.";
const SELF_IMPROVEMENT_FINAL_BLOCK = `Final block must end with these exact labels at column 1:
Single highest-leverage weakness: <the clearest root weakness>
Smallest durable improvement: <the smallest reusable improvement landed or specified>
Measurable signal: <the metric, baseline, trace, or acceptance check>
Next follow-on patch: <the next patch candidate, not a queued claim unless a task tool was used>`;

const DISCIPLINES = [
	{
		slug: "systems-architecture",
		label: "Systems Architecture",
		description:
			"Make Zaraa's internal structure simpler, more legible, and less failure-prone.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Routing topology",
				"Model routing, task routing, and zone routing can overlap in ways that hide root cause when quality drops.",
				"a routing map plus one simplification patch",
				"wrong-router incidents and decision latency",
				"high",
			),
			focus(
				"Plugin boundaries",
				"Plugin responsibilities can sprawl until ownership is fuzzy and integrations become brittle.",
				"a boundary contract and ownership matrix",
				"plugin collision rate and integration churn",
				"high",
			),
			focus(
				"Task queue flow",
				"Task intake, dedup, claiming, and completion paths can drift apart under load.",
				"a queue lifecycle diagram and one bottleneck fix",
				"queue time-to-start and duplicate task rate",
				"high",
			),
			focus(
				"Context assembly",
				"Context gathering can become expensive, inconsistent, or overstuffed for the actual task.",
				"a context assembly rulebook",
				"context token load and context-hit usefulness",
				"normal",
			),
			focus(
				"Provider failover",
				"Fallback logic can rescue outages but still leave silent quality regressions behind.",
				"a failover decision tree",
				"provider recovery time and degraded-response rate",
				"high",
			),
			focus(
				"Event bus contracts",
				"Events can multiply faster than their contracts stay documented and trustworthy.",
				"an event contract inventory",
				"event schema violations and orphan listeners",
				"normal",
			),
			focus(
				"Zone transitions",
				"Crossing sandbox, guarded, and trusted execution boundaries can feel magical instead of inspectable.",
				"a zone transition checklist",
				"unsafe transition attempts and approval friction",
				"high",
			),
			focus(
				"State persistence",
				"Long-running state can survive just long enough to become stale and misleading.",
				"a persistence freshness plan",
				"stale-state incidents and recovery time after restart",
				"normal",
			),
			focus(
				"Scheduler handoffs",
				"Scheduled work can lose intent or context when it jumps from planner to executor.",
				"a scheduler handoff contract",
				"scheduled-task success rate and handoff clarity",
				"normal",
			),
			focus(
				"Recovery checkpoints",
				"Recovery exists, but checkpoints may be too sparse or too noisy to trust in a real incident.",
				"a checkpoint policy",
				"resume success rate and lost-work percentage",
				"high",
			),
		],
	},
	{
		slug: "debugging-reliability",
		label: "Debugging & Reliability",
		description:
			"Turn obscure failures into reproducible, recoverable events with clear ownership.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Crash triage",
				"Crashes can leave behind too much smoke and not enough signal for fast diagnosis.",
				"a crash triage runbook",
				"mean time to first actionable diagnosis",
				"high",
			),
			focus(
				"Timeout recovery",
				"Timeouts can masquerade as random flakiness when no recovery ladder is explicit.",
				"a timeout recovery ladder",
				"timeout recurrence and successful automatic retries",
				"high",
			),
			focus(
				"Duplicate dispatches",
				"Near-identical tasks can still sneak through dedup windows and waste compute.",
				"a duplicate-dispatch containment patch",
				"duplicate execution rate",
				"normal",
			),
			focus(
				"Stuck task detection",
				"Tasks can look alive long after meaningful progress has stopped.",
				"a stuck-task detector and escalation rule",
				"stuck-task detection latency",
				"high",
			),
			focus(
				"Partial failure handling",
				"Multi-step work can partially succeed without preserving what is salvageable.",
				"a partial-success protocol",
				"recoverable output retained after failure",
				"normal",
			),
			focus(
				"Slow path visibility",
				"Latency outliers are easy to feel and hard to localize without deliberate instrumentation.",
				"a slow-path observability panel",
				"p95 task latency and unexplained slow paths",
				"normal",
			),
			focus(
				"Retry logic hygiene",
				"Retries can help on paper while amplifying the wrong failure mode in practice.",
				"a retry policy matrix",
				"retry success rate vs retry-caused pressure",
				"normal",
			),
			focus(
				"Log signal quality",
				"Logs often say something happened without saying enough to fix it.",
				"a logging quality rubric",
				"log usefulness during incident review",
				"normal",
			),
			focus(
				"Dependency degradation",
				"External failures can spread too far before the system gracefully narrows scope.",
				"a degraded-mode plan",
				"graceful-degradation success rate",
				"high",
			),
			focus(
				"Self-healing playbooks",
				"Automatic recovery can exist as scattered instincts instead of a disciplined playbook.",
				"a self-healing catalog",
				"incident classes closed without human rescue",
				"normal",
			),
		],
	},
	{
		slug: "testing-qa",
		label: "Testing & QA",
		description:
			"Expand confidence from passing tests to resilient behavior under real pressure.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Acceptance coverage",
				"Core user journeys can still succeed in unit tests while failing at the edges that matter.",
				"an acceptance test gap map",
				"critical journey coverage",
				"high",
			),
			focus(
				"Contract tests",
				"Integration seams can drift quietly until runtime proves the contract was imaginary.",
				"a contract-test matrix",
				"schema breakages caught before runtime",
				"high",
			),
			focus(
				"Simulation realism",
				"Simulations can be fast and deterministic without being sufficiently life-like.",
				"a realism upgrade plan",
				"simulation-to-production failure overlap",
				"normal",
			),
			focus(
				"Edge-case packs",
				"Known weird inputs are not always preserved as durable regression cases.",
				"an edge-case pack library",
				"regressions prevented by edge-case fixtures",
				"normal",
			),
			focus(
				"Flake hunting",
				"Intermittent failures erode trust faster than visible failures because they waste attention.",
				"a flake triage board",
				"test flake rate",
				"high",
			),
			focus(
				"Regression guardrails",
				"Past breakages may be remembered socially but not encoded technically.",
				"a regression memorial checklist",
				"repeat regressions per release",
				"high",
			),
			focus(
				"Fixture hygiene",
				"Fixtures can age into misleading convenience data that no longer reflects production reality.",
				"a fixture freshness audit",
				"stale-fixture discovery rate",
				"normal",
			),
			focus(
				"Mutation-style challenge cases",
				"Tests that confirm the happy path can still miss fragile reasoning or accidental implementation details.",
				"a challenge-case pack",
				"surviving mutant-style defects",
				"normal",
			),
			focus(
				"Cross-platform parity",
				"CLI, web, iOS, and daemon behavior can drift without a shared parity ritual.",
				"a parity verification checklist",
				"cross-surface mismatch count",
				"normal",
			),
			focus(
				"Release smoke packs",
				"Ship readiness often relies on memory and momentum instead of repeatable smoke checks.",
				"a release smoke pack",
				"pre-release issue catch rate",
				"high",
			),
		],
	},
	{
		slug: "security-privacy",
		label: "Security & Privacy",
		description:
			"Reduce the blast radius of mistakes while preserving useful autonomy.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Secret scrubbing",
				"Secrets can still leak through logs, prompts, and copied context unless scrubbing is relentlessly verified.",
				"a secret-scrubbing review and patch",
				"secret leak detections",
				"high",
			),
			focus(
				"Prompt injection defense",
				"Hostile content can still manipulate tool use if detection and containment are too shallow.",
				"an injection defense playbook",
				"injection attempts safely contained",
				"high",
			),
			focus(
				"Zone permission boundaries",
				"Execution scopes can feel conceptually clean while hidden exceptions quietly expand the blast radius.",
				"a zone boundary audit",
				"unauthorized action attempts blocked",
				"high",
			),
			focus(
				"Outbound allowlists",
				"Network access can sprawl unless destinations and reasons are intentionally governed.",
				"an outbound access policy",
				"unknown outbound destinations",
				"normal",
			),
			focus(
				"Audit trail clarity",
				"Actions can be technically logged but still too hard to reconstruct during review.",
				"an audit trail readability patch",
				"audit completeness during incident replay",
				"normal",
			),
			focus(
				"Data minimization",
				"Retaining more context than necessary increases both privacy risk and cognitive noise.",
				"a data minimization plan",
				"unneeded sensitive fields retained",
				"normal",
			),
			focus(
				"Credential rotation",
				"Keys are only healthy if rotation is practiced instead of postponed indefinitely.",
				"a credential rotation routine",
				"rotation cadence adherence",
				"normal",
			),
			focus(
				"Unsafe tool denial",
				"Tool gating can fail softly when the risky path still looks convenient in the moment.",
				"a tool denial and fallback plan",
				"unsafe tool attempts avoided or contained",
				"high",
			),
			focus(
				"Memory privacy review",
				"Stored memories can become privacy debt if their sensitivity is not re-evaluated over time.",
				"a memory privacy rubric",
				"sensitive memories correctly classified",
				"normal",
			),
			focus(
				"Social engineering resistance",
				"Friendly phrasing can still be used to smuggle unsafe requests past good intentions.",
				"a social-engineering red-team pack",
				"unsafe persuasion attempts resisted",
				"high",
			),
		],
	},
	{
		slug: "memory-knowledge",
		label: "Memory & Knowledge",
		description:
			"Keep memory useful, current, and compact enough to compound instead of clutter.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Duplicate memory cleanup",
				"Semantically identical memories can pile up and blur what should feel crisp.",
				"a deduplication patch",
				"duplicate memory rate",
				"high",
			),
			focus(
				"Contradiction resolution",
				"Memories can conflict quietly until they undermine planning or trust.",
				"a contradiction resolution workflow",
				"unresolved contradictory memory count",
				"high",
			),
			focus(
				"Retrieval ranking",
				"Relevant memories can exist and still lose to noisier but easier-to-match fragments.",
				"a retrieval ranking improvement plan",
				"top-k relevance on memory lookups",
				"high",
			),
			focus(
				"Procedural memory quality",
				"Stored procedures can drift from best practice or stay too vague to execute reliably.",
				"a procedural memory scorecard",
				"procedure execution success rate",
				"normal",
			),
			focus(
				"Semantic freshness",
				"Facts can quietly expire while still sounding authoritative in retrieval.",
				"a freshness verification loop",
				"stale fact detection rate",
				"normal",
			),
			focus(
				"Lesson extraction",
				"Real mistakes happen faster than the lessons are distilled from them.",
				"a lessons-learned extraction template",
				"incidents converted into reusable lessons",
				"normal",
			),
			focus(
				"Context packing",
				"Too much memory context can dilute the very insight it was meant to preserve.",
				"a context packing heuristic",
				"context compactness vs answer quality",
				"normal",
			),
			focus(
				"Memory verification",
				"Stored knowledge needs periodic spot checks or it turns into confident folklore.",
				"a memory verification protocol",
				"verified-memory coverage",
				"normal",
			),
			focus(
				"Gap-driven research",
				"Knowledge gaps are only valuable if they consistently create learning work instead of vague frustration.",
				"a gap-to-research bridge",
				"identified gaps converted into research tasks",
				"normal",
			),
			focus(
				"Archival strategy",
				"Not every memory deserves prime attention forever, but archive rules may be too fuzzy.",
				"an archival lifecycle",
				"active-memory density and archive retrieval usefulness",
				"normal",
			),
		],
	},
	{
		slug: "tool-mastery-automation",
		label: "Tool Mastery & Automation",
		description:
			"Choose the right tools sooner, chain them more cleanly, and automate the boring wins.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Tool selection heuristics",
				"The right tool can still arrive one step too late if selection heuristics are fuzzy.",
				"a tool-selection rubric",
				"wrong-first-tool rate",
				"high",
			),
			focus(
				"Multi-tool planning",
				"Chains of tools can work but still feel improvised rather than designed.",
				"a multi-tool sequencing playbook",
				"successful multi-tool completion rate",
				"high",
			),
			focus(
				"Shell safety",
				"Command-line power needs a stronger muscle memory for safety, reversibility, and signal.",
				"a shell safety checklist",
				"unsafe command attempts avoided",
				"high",
			),
			focus(
				"File edit discipline",
				"Edits can succeed while still being harder to review, validate, or revert than necessary.",
				"an edit-discipline patch",
				"clean edit reviewability",
				"normal",
			),
			focus(
				"Web research chains",
				"Research can gather facts without leaving behind a durable sourcing habit.",
				"a web research chain template",
				"source-backed answer rate",
				"normal",
			),
			focus(
				"App control playbooks",
				"Computer-use actions can be powerful but need tighter playbooks for repeatable value.",
				"an app-control playbook pack",
				"successful app automations",
				"normal",
			),
			focus(
				"Parameter validation",
				"Bad parameters can travel surprisingly far before a tool refuses them.",
				"a parameter validation layer",
				"tool-call failure rate from malformed inputs",
				"normal",
			),
			focus(
				"Tool fallback trees",
				"Fallbacks exist, but they may be remembered ad hoc instead of encoded deliberately.",
				"a fallback tree catalog",
				"recoveries achieved via fallback path",
				"normal",
			),
			focus(
				"Automation candidate detection",
				"Repeated manual work may go unnoticed unless there is a formal way to spot it.",
				"an automation candidate detector",
				"repeated patterns promoted into automation",
				"normal",
			),
			focus(
				"Result summarization",
				"Tool output can be technically correct while still leaving the operator with too much raw noise.",
				"a tool-summary standard",
				"summary usefulness after tool-heavy tasks",
				"normal",
			),
		],
	},
	{
		slug: "research-intelligence",
		label: "Research & Intelligence",
		description:
			"Raise the quality of sourced thinking, recency handling, and synthesis under uncertainty.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Source authority ranking",
				"Not all sources deserve the same trust, but that hierarchy can blur under speed pressure.",
				"a source authority ladder",
				"primary-source usage rate",
				"high",
			),
			focus(
				"Recency discipline",
				"Fast-changing topics punish stale memory more harshly than static ones.",
				"a recency-check protocol",
				"time-sensitive answers verified before response",
				"high",
			),
			focus(
				"Conflicting evidence synthesis",
				"Disagreement between sources needs interpretation, not false certainty.",
				"a conflict-synthesis template",
				"conflicting-source cases resolved clearly",
				"normal",
			),
			focus(
				"Direct quote hygiene",
				"Quoted material can become too long, too sparse, or poorly grounded without explicit discipline.",
				"a quote-usage rubric",
				"citation clarity and quote compliance",
				"normal",
			),
			focus(
				"Competitor tracking",
				"Competitive awareness can become sporadic instead of systematic.",
				"a competitor watch board",
				"tracked competitor changes surfaced per cycle",
				"normal",
			),
			focus(
				"Market scanning",
				"Broad scans can feel busy without a reliable way to surface the few things that matter.",
				"a scan triage framework",
				"signal-to-noise ratio in market scans",
				"normal",
			),
			focus(
				"Technical docs digestion",
				"Documentation can be read accurately without being transformed into durable working knowledge.",
				"a docs-to-procedure pipeline",
				"docs insights converted into action",
				"normal",
			),
			focus(
				"Experiment design",
				"Research questions can stay fuzzy long enough to waste time on shallow browsing.",
				"an experiment framing template",
				"research tasks with explicit hypotheses",
				"normal",
			),
			focus(
				"Assumption logs",
				"Useful assumptions can remain invisible and therefore unchallenged.",
				"an assumption register",
				"assumptions surfaced before risky conclusions",
				"normal",
			),
			focus(
				"Insight packaging",
				"Good research can still land weakly if the takeaways are not shaped for action.",
				"an insight packaging standard",
				"research outputs that directly change decisions",
				"normal",
			),
		],
	},
	{
		slug: "communication-relationship-ops",
		label: "Communication & Relationship Ops",
		description:
			"Make communication clearer, warmer, better timed, and easier to follow through on.",
		defaultZone: "guarded",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Clarifying question discipline",
				"Ambiguous asks can still trigger premature action when one careful question would save the turn.",
				"a clarification decision tree",
				"avoidable misfires from ambiguous requests",
				"high",
			),
			focus(
				"Follow-up tracking",
				"Pending threads can slip when intention is not paired with a visible follow-up system.",
				"a follow-up tracker",
				"open loops closed on time",
				"high",
				"guarded",
			),
			focus(
				"Meeting prep",
				"Meetings are easier to survive than to leverage unless preparation is consistent.",
				"a meeting prep protocol",
				"prepared meetings with relevant context ready",
				"normal",
				"guarded",
			),
			focus(
				"Tone adaptation",
				"Good intent can still land wrong if tone does not adapt to channel and relationship.",
				"a tone adaptation matrix",
				"tone corrections requested after drafts",
				"normal",
				"guarded",
			),
			focus(
				"Bad news delivery",
				"Hard messages can become either too blunt or too vague without a clear pattern.",
				"a hard-message template",
				"clarity and trust in difficult updates",
				"normal",
				"guarded",
			),
			focus(
				"Ask-offer balance",
				"Relationship energy can get lopsided when asks are easier to remember than value offered.",
				"an ask-offer balance review",
				"relationship reciprocity awareness",
				"low",
				"guarded",
			),
			focus(
				"Relationship memory",
				"Useful interpersonal context can stay scattered across episodic fragments.",
				"a relationship memory schema",
				"relevant contact context retrieved at the right time",
				"normal",
				"guarded",
			),
			focus(
				"Decision summaries",
				"Conversations can end with implicit decisions that no one can point to later.",
				"a decision summary template",
				"threads ending with a clear next step",
				"normal",
				"guarded",
			),
			focus(
				"Cross-channel consistency",
				"Tone and commitments can drift across email, chat, notes, and voice if not harmonized.",
				"a cross-channel consistency check",
				"mismatched commitments across channels",
				"low",
				"guarded",
			),
			focus(
				"Escalation timing",
				"Escalating too early or too late both create avoidable tension.",
				"an escalation timing guide",
				"escalations that arrive at the right moment",
				"normal",
				"guarded",
			),
		],
	},
	{
		slug: "strategic-planning-prioritization",
		label: "Strategic Planning & Prioritization",
		description:
			"Protect long-term leverage by choosing what matters before momentum chooses for you.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Goal stack clarity",
				"Top-level goals can sound aligned while still competing for the same finite attention.",
				"a goal stack and tension map",
				"clarity of top-priority objective",
				"high",
			),
			focus(
				"Backlog ranking",
				"A rich backlog can become an expensive excuse to avoid the hard ranking work.",
				"a backlog scoring rubric",
				"ranked backlog coverage",
				"high",
			),
			focus(
				"Critical path mapping",
				"Important work can stall because dependencies are felt but not mapped.",
				"a critical path map",
				"blocked work surfaced before execution",
				"normal",
			),
			focus(
				"Opportunity cost analysis",
				"Every yes creates hidden noes that deserve to be seen explicitly.",
				"an opportunity-cost review",
				"tradeoffs stated in major decisions",
				"normal",
			),
			focus(
				"Kill criteria",
				"Projects often need a graceful stop condition as much as they need ambition.",
				"a kill-criteria framework",
				"active efforts with explicit stop conditions",
				"normal",
			),
			focus(
				"Pre-mortems",
				"Failures are easier to avoid before ego becomes attached to the current shape of a plan.",
				"a pre-mortem template",
				"major initiatives with documented pre-mortems",
				"normal",
			),
			focus(
				"Resource allocation",
				"Time, attention, and compute can drift away from stated priorities unless allocation is visible.",
				"a resource allocation view",
				"resource spend aligned with top goals",
				"high",
			),
			focus(
				"Focus window planning",
				"Deep work windows are valuable enough to need explicit protection instead of hopeful intention.",
				"a focus-window planner",
				"protected deep-work blocks honored",
				"normal",
			),
			focus(
				"Scenario planning",
				"Plans are easier to trust when they survive more than one plausible future.",
				"a scenario planning kit",
				"important strategies tested against multiple scenarios",
				"normal",
			),
			focus(
				"Review cadence",
				"Good plans decay if review rhythms are inconsistent or too vague.",
				"a review cadence calendar",
				"strategic reviews completed on schedule",
				"normal",
			),
		],
	},
	{
		slug: "product-ux",
		label: "Product & UX",
		description:
			"Make Zaraa easier to understand, easier to trust, and easier to recover with.",
		defaultZone: "guarded",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Onboarding friction",
				"Powerful features can still stay unused if the first run asks for too much certainty.",
				"an onboarding friction audit",
				"drop-off points in first-run setup",
				"high",
				"guarded",
			),
			focus(
				"Error states",
				"Error messages can be technically correct without making the next step obvious.",
				"an error-state rewrite pack",
				"recoverability from visible errors",
				"high",
				"guarded",
			),
			focus(
				"Dashboard clarity",
				"Important state can drown in a dashboard when everything looks equally urgent.",
				"a dashboard information hierarchy patch",
				"time-to-find-key-status",
				"normal",
				"guarded",
			),
			focus(
				"Mobile ergonomics",
				"Useful flows can still be annoying on the surfaces where they matter most.",
				"a mobile friction report",
				"taps and scrolls needed for core actions",
				"normal",
				"guarded",
			),
			focus(
				"Preference learning",
				"User preferences can be remembered inconsistently across features and surfaces.",
				"a preference memory strategy",
				"preferences applied correctly in future interactions",
				"normal",
				"guarded",
			),
			focus(
				"Notification design",
				"Helpful notifications can tip into stress if urgency language is not calibrated.",
				"a notification severity guide",
				"notifications that change behavior without causing fatigue",
				"normal",
				"guarded",
			),
			focus(
				"User journey gaps",
				"Cross-feature journeys often fail in the handoff points, not the individual screens.",
				"a user journey gap map",
				"broken journey handoffs discovered and fixed",
				"normal",
				"guarded",
			),
			focus(
				"Copy sharpness",
				"Interface copy can sound serviceable while still missing the fastest path to comprehension.",
				"a copy clarity pass",
				"user-facing text revisions that reduce confusion",
				"low",
				"guarded",
			),
			focus(
				"Approval flows",
				"Approvals should feel like trust-building checkpoints, not panic buttons.",
				"an approval flow refinement plan",
				"approval friction vs safety confidence",
				"normal",
				"guarded",
			),
			focus(
				"Feedback capture",
				"Good feedback is less useful when it cannot be tied back to the moment that produced it.",
				"a feedback capture loop",
				"feedback linked to actionable product changes",
				"low",
				"guarded",
			),
		],
	},
	{
		slug: "finance-trading-operations",
		label: "Finance & Trading Operations",
		description:
			"Improve money decisions, risk control, and post-trade learning without delusion.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Position sizing",
				"Good ideas can still lose money if size is detached from edge, volatility, and correlation.",
				"a position sizing calibration patch",
				"risk per trade vs plan adherence",
				"high",
			),
			focus(
				"Drawdown protocol",
				"Drawdowns need a pre-committed response before stress starts bargaining.",
				"a drawdown response ladder",
				"drawdown breaches handled according to plan",
				"high",
			),
			focus(
				"Strategy attribution",
				"P&L is noisy unless wins and losses are traced back to the system that generated them.",
				"a strategy attribution report",
				"trade outcomes tagged to strategy logic",
				"high",
			),
			focus(
				"Regime detection",
				"Strategies can quietly mismatch market regime long before the journal says so.",
				"a regime detection refinement",
				"strategy-regime mismatch rate",
				"high",
			),
			focus(
				"Market scan quality",
				"Scanning markets can become a ritual unless it consistently surfaces truly tradeable ideas.",
				"a scan quality scorecard",
				"tradeable opportunities surfaced per scan",
				"normal",
			),
			focus(
				"Execution quality",
				"Entry logic can be fine while execution leaks edge through slippage and timing.",
				"an execution quality review",
				"slippage and fill quality vs plan",
				"high",
			),
			focus(
				"Portfolio concentration",
				"Apparent diversification can still hide concentrated risk through correlated bets.",
				"a concentration heatmap",
				"portfolio correlation and concentration score",
				"high",
			),
			focus(
				"Alert discipline",
				"Alerts can multiply into background noise if their thresholds are not earned.",
				"an alert hygiene pass",
				"alerts acted on vs alerts ignored",
				"normal",
			),
			focus(
				"Prediction market EV",
				"Expected value can sound precise while still ignoring liquidity, resolution rules, or edge decay.",
				"an EV validation checklist",
				"EV estimates that survive post-resolution review",
				"normal",
			),
			focus(
				"Trading journal loop",
				"Journaling only compounds when lessons change the next trade, not just describe the last one.",
				"a journal-to-rule pipeline",
				"journal insights converted into rule changes",
				"normal",
			),
		],
	},
	{
		slug: "data-analytics",
		label: "Data & Analytics",
		description:
			"Improve measurement so decisions are based on useful truth instead of dashboard theater.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Metric definitions",
				"A metric is only useful if everyone means the same thing when they say its name.",
				"a metric definition catalog",
				"metrics with unambiguous definitions",
				"high",
			),
			focus(
				"Instrumentation completeness",
				"You cannot analyze what you never bothered to emit.",
				"an instrumentation gap audit",
				"important flows with complete telemetry",
				"high",
			),
			focus(
				"Dashboard trust",
				"Dashboards are dangerous when they look polished before they become trustworthy.",
				"a dashboard trust checklist",
				"trustworthy metrics with source traceability",
				"normal",
			),
			focus(
				"Anomaly detection",
				"Problems are easier to miss when the system only reports absolutes and not unusual change.",
				"an anomaly detection patch",
				"time-to-detect abnormal behavior",
				"normal",
			),
			focus(
				"Data quality checks",
				"Broken inputs can quietly spoil confident outputs.",
				"a data quality ruleset",
				"data integrity issues caught before downstream use",
				"high",
			),
			focus(
				"Experiment readouts",
				"Experiments can create movement without creating learning if readouts stay fuzzy.",
				"an experiment readout template",
				"experiments ending with explicit decision outcomes",
				"normal",
			),
			focus(
				"Trace analysis",
				"Rich traces are only useful if important patterns can actually be extracted from them.",
				"a trace analysis workflow",
				"high-value trace patterns surfaced per review",
				"normal",
			),
			focus(
				"Schema evolution",
				"Data structures evolve whether or not migration discipline keeps pace.",
				"a schema evolution playbook",
				"schema changes that preserve backward compatibility",
				"normal",
			),
			focus(
				"Forecast vs actual",
				"Predictions do not improve unless forecast quality is measured against reality.",
				"a forecast calibration tracker",
				"forecast error by domain",
				"normal",
			),
			focus(
				"Root-cause measurement",
				"Symptoms are easier to count than actual causes unless instrumentation is intentional.",
				"a root-cause taxonomy",
				"incidents classified by true cause instead of surface symptom",
				"normal",
			),
		],
	},
	{
		slug: "creativity-brand-systems",
		label: "Creativity & Brand Systems",
		description:
			"Support expressive work with enough structure that creative momentum actually compounds.",
		defaultZone: "guarded",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Voice consistency",
				"Strong creative identity needs consistency without flattening the edges that make it alive.",
				"a voice system guide",
				"brand voice consistency across outputs",
				"normal",
				"guarded",
			),
			focus(
				"Content cadence",
				"Creative publishing often fails from erratic rhythm more than lack of ideas.",
				"a cadence and batching plan",
				"weeks with sustainable content output",
				"normal",
				"guarded",
			),
			focus(
				"Release sequencing",
				"Good creative work can lose force if release order and prep are improvised.",
				"a release sequencing playbook",
				"release tasks completed on time",
				"normal",
				"guarded",
			),
			focus(
				"Collaboration workflows",
				"Collaboration energy gets lost when handoffs rely on memory instead of a shared pattern.",
				"a collaboration handoff kit",
				"collaboration cycles completed without dropped context",
				"normal",
				"guarded",
			),
			focus(
				"Idea capture",
				"Inspiration is plentiful enough to become wasteful without frictionless capture and retrieval.",
				"an idea capture system",
				"captured ideas later reused in active work",
				"normal",
				"guarded",
			),
			focus(
				"Archive hygiene",
				"Creative assets can disappear into folders that preserve files but destroy momentum.",
				"an archive hygiene plan",
				"time-to-find prior assets",
				"low",
				"guarded",
			),
			focus(
				"Live performance ops",
				"Live execution needs routines sturdy enough to survive the chaos around them.",
				"a live-ops checklist",
				"preventable live-show misses",
				"normal",
				"guarded",
			),
			focus(
				"Brand asset system",
				"Visual and messaging assets drift unless there is a current source of truth.",
				"a brand asset registry",
				"asset reuse consistency",
				"low",
				"guarded",
			),
			focus(
				"Storytelling themes",
				"Interesting work often lacks a durable narrative spine that helps it travel.",
				"a storytelling theme bank",
				"content pieces tied to recurring narrative themes",
				"low",
				"guarded",
			),
			focus(
				"Merch and offer design",
				"Offers are stronger when they express identity instead of feeling bolted on.",
				"a merch and offer idea deck",
				"viable offers shipped from the idea pool",
				"low",
				"guarded",
			),
		],
	},
	{
		slug: "personal-optimization-habits",
		label: "Personal Optimization & Habits",
		description:
			"Help Zaraa support a human life with rhythm, recovery, and enough friction reduction to matter.",
		defaultZone: "guarded",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Morning startup",
				"The day starts better when startup steps are ordered, lightweight, and impossible to forget.",
				"a morning startup protocol",
				"morning routine completion consistency",
				"normal",
				"guarded",
			),
			focus(
				"Shutdown ritual",
				"Unclosed loops multiply overnight unless the shutdown ritual is concrete and short enough to use.",
				"an end-of-day shutdown checklist",
				"days ending with a clean shutdown",
				"high",
				"guarded",
			),
			focus(
				"Energy mapping",
				"Not all hours are equally useful, and pretending otherwise creates hidden drag.",
				"an energy map",
				"important work aligned with strong energy windows",
				"normal",
				"guarded",
			),
			focus(
				"Focus protection",
				"Deep work needs more than intention; it needs explicit defense against interruption.",
				"a focus protection protocol",
				"protected focus blocks completed",
				"high",
				"guarded",
			),
			focus(
				"Decision fatigue",
				"Cognitive quality degrades when too many choices stay open too long.",
				"a decision fatigue detector",
				"late-session decision quality",
				"normal",
				"guarded",
			),
			focus(
				"Recovery blocks",
				"Recovery tends to be treated as leftover time instead of a strategic requirement.",
				"a recovery scheduling plan",
				"recovery blocks protected and honored",
				"normal",
				"guarded",
			),
			focus(
				"Reading queue",
				"Interesting inputs can overwhelm unless there is a system for ranking and revisiting them.",
				"a reading queue workflow",
				"relevant reads completed from the queue",
				"low",
				"guarded",
			),
			focus(
				"Anti-procrastination triggers",
				"Starting is easier when the first move is already chosen before resistance arrives.",
				"an anti-procrastination trigger set",
				"tasks started without avoidable delay",
				"normal",
				"guarded",
			),
			focus(
				"Environment design",
				"Attention follows the environment more obediently than it follows promises.",
				"an environment friction audit",
				"distraction sources removed or reduced",
				"low",
				"guarded",
			),
			focus(
				"Weekly review quality",
				"Reviews should change next week, not merely describe the last one.",
				"a weekly review upgrade",
				"review actions carried into the next week",
				"normal",
				"guarded",
			),
		],
	},
	{
		slug: "autonomy-self-reflection",
		label: "Autonomy & Self-Reflection",
		description:
			"Increase Zaraa's independence by sharpening her honesty, calibration, and learning loops.",
		defaultZone: "trusted",
		starterFocusIndex: 0,
		foci: [
			focus(
				"Reflection quality",
				"Reflections are only useful when they are specific enough to change future behavior.",
				"a reflection quality rubric",
				"reflections producing concrete next actions",
				"high",
			),
			focus(
				"Confidence calibration",
				"Confidence is harmful when it outpaces evidence and equally harmful when it hides useful conviction.",
				"a confidence calibration scorecard",
				"confidence vs outcome calibration error",
				"high",
			),
			focus(
				"Correction generalization",
				"A correction is wasted if it fixes one phrasing and misses the underlying pattern.",
				"a correction generalization workflow",
				"corrections that prevent similar future mistakes",
				"high",
			),
			focus(
				"Failure clustering",
				"Incidents feel random until they are grouped into a few recurring families.",
				"a failure clustering report",
				"failure families with owners and countermeasures",
				"normal",
			),
			focus(
				"Autonomy boundaries",
				"Independence compounds only when the danger zones stay sharply defined.",
				"an autonomy boundary map",
				"safe autonomous actions expanded without safety regressions",
				"high",
			),
			focus(
				"Patch sequencing",
				"Improvements arrive faster when patches are ordered by leverage instead of whim.",
				"a patch sequencing framework",
				"patches executed in strategic order",
				"normal",
			),
			focus(
				"Goal retirement",
				"Goals can remain active out of inertia long after they have stopped being alive.",
				"a goal retirement checklist",
				"stale goals retired or refreshed on time",
				"normal",
			),
			focus(
				"Delegation heuristics",
				"Delegation improves throughput only if ownership and timing are chosen well.",
				"a delegation heuristic guide",
				"delegated work that returns useful results without churn",
				"normal",
			),
			focus(
				"Self-critique candor",
				"Politeness is not improvement if it hides the actual problem.",
				"a candor standard for self-review",
				"self-critiques naming the real issue",
				"normal",
			),
			focus(
				"Compounding rule creation",
				"Learning compounds fastest when it becomes a rule, checklist, or guardrail instead of a vibe.",
				"a compounding rules ledger",
				"new durable rules created from real work",
				"high",
			),
		],
	},
];

function selfImprovementFocusGuidance(focusArea) {
	if (focusArea === "Zone transitions") {
		return [
			"- The `Patch artifact:` line should clearly name a zone transition checklist.",
			"- Do not cite `task_list` reasons, counts, or blocked-task explanations unless you actually retrieved them during this run.",
			"- A safe checklist shape is: `Patch artifact: Zone transition checklist — boundary state: <state or crossing>; approval gate: <gate>; owner: <owner>; highest-risk unsafe crossing: <crossing>; missing verification step: <gap>.`",
			"- Do not leave any angle-bracket placeholder, ellipsis, or repeated label text in the final block. If any `<...>` token survives into the answer, the answer is wrong.",
			"- A response fails if `Evidence used:` only says generic phrases like `boundary code` or `approval logic` without at least one exact file path, test name, trace, or explicitly named blocker.",
			"- If you cannot ground at least one exact local anchor, stop and write the exact blocker on `Evidence used:` instead of drafting a vague checklist.",
			"- A grounded example shape for this repo is: use `packages/core/src/gateway/server.ts` as an exact local anchor when it is relevant to the transition you inspected.",
			"- Evidence used: <exact file path, test name, trace, or exact blocker>; include at least one concrete local anchor.",
		].join("\n");
	}

	if (focusArea === "State persistence") {
		return [
			"- For state persistence work, common anchors include `packages/core/src/tasks/task-store.ts`, `packages/core/src/tasks/task-metadata.ts`, and `packages/core/src/runtime/session-recovery.ts`.",
			"- Do not answer with a generic failure report, apology, or meta-commentary about being unable to continue.",
			"- The `Patch artifact:` line should clearly name a persistence freshness plan and explicitly cover: what state is durable, what state expires, what must be revalidated after restart, and the clearest stale-state risk.",
			"- Include `packages/core/src/runtime/session-recovery.ts` when restart revalidation is part of the evidence you inspected.",
			"- A safe example shape is: `Patch artifact: Persistence freshness plan — durable state: task status/result plus task metadata persisted through `packages/core/src/tasks/task-store.ts`; expires: stale runtime/session assumptions; revalidate after restart: queue freshness, active task ownership, and recovery boundaries; stale-state risk: resurrecting work that no longer has valid context.`",
		].join("\n");
	}

	return "";
}

function renderStructuredPrompt({ id, discipline, patchWaveLabel, patchDirective, focusArea, gap, artifact, successMetric, zone, priority }) {
	const focusGuidance = selfImprovementFocusGuidance(focusArea);
	return `[Zaraa Self-Improvement ${patchWaveLabel}]
Task ID: ${id}
Discipline: ${discipline}
Focus Area: ${focusArea}
Priority: ${priority}
Execution Zone: ${zone}

Mission:
Improve Zaraa through the ${discipline} discipline. This patch should ${patchDirective}.

Current Gap:
${gap}

	Required Deliverable:
	- Produce ${artifact}.
	- Use concrete evidence from the current codebase, tests, docs, traces, memories, or live telemetry where available.
	- Follow an evidence ladder: prefer local code/docs/tasks/traces/memories first; only browse or web-search when you have a concrete query worth asking.
	${focusGuidance ? `${focusGuidance}\n\t` : ""}- Name the single highest-leverage weakness you find in this focus area.
	- Define or update at least one measurable signal for ${successMetric}.
	- End by writing the next follow-on patch that would compound this gain.

Operating Rules:
- Prefer durable systems over one-off heroics.
- Simplify before adding machinery.
- If a tool call fails because of bad parameters or a shallow mistake, retry once with corrected input before concluding.
- Do not claim an audit or baseline unless you actually gathered evidence. If evidence is blocked or unavailable, say exactly what is missing and land the smallest grounded output.
- ${TASK_CREATION_CLAIM_GUARD}
- ${NEXT_PATCH_CANDIDATE_GUARD}
- ${NO_TASK_CREATION_GUARD}
- ${MEASUREMENT_EVIDENCE_GUARD}
- If the full fix is too large, land the smallest durable patch and preserve the next step clearly.
- When a lesson should survive this session, store it as a reusable rule, checklist, playbook, or clearly named next follow-on patch.

Definition of Done:
- The weakness is visible.
- The improvement path is concrete.
- The measurement is explicit.
- Future-Zaraa can continue from this patch without re-deriving the work.
- ${SELF_IMPROVEMENT_HANDOFF_GUARD}
- ${SELF_IMPROVEMENT_FINAL_BLOCK}
`;
}

function renderOperatorPrompt({
	id,
	discipline,
	patchWaveLabel,
	patchDirective,
	focusArea,
	gap,
	artifact,
	successMetric,
	zone,
	priority,
}) {
	const focusGuidance = selfImprovementFocusGuidance(focusArea);
	return `Zaraa, I want you to take the lead on a self-improvement patch for ${discipline}.

Patch:
- ID: ${id}
- Wave: ${patchWaveLabel}
- Focus: ${focusArea}
- Priority: ${priority}
- Zone: ${zone}

What I'm noticing:
${gap}

What I need from you in this round:
- ${patchDirective.charAt(0).toUpperCase()}${patchDirective.slice(1)}.
	- Deliver ${artifact}.
	- Work from the real state of the codebase, tests, docs, traces, memories, or live telemetry wherever that helps.
	- Use an evidence ladder: start with local code/docs/tasks/traces/memories, and only browse when you have an explicit query worth asking.
	${focusGuidance ? `${focusGuidance}\n\t` : ""}- Tell me the single highest-leverage weakness you find in this focus area.
	- Define or update at least one measurable signal for ${successMetric}.
- End by telling me what the next follow-on patch should be if this one lands cleanly.

How I want you to approach it:
- Prefer durable improvements over clever one-off heroics.
- Simplify before adding machinery.
- If a tool call fails because of bad parameters or a shallow mistake, retry once with corrected input before concluding.
- Do not pretend you completed an audit if the evidence never arrived. Tell me exactly what was blocked or unavailable, then land the smallest grounded move.
- ${TASK_CREATION_CLAIM_GUARD}
- ${NEXT_PATCH_CANDIDATE_GUARD}
- ${NO_TASK_CREATION_GUARD}
- ${MEASUREMENT_EVIDENCE_GUARD}
- If the whole fix is too large, land the smallest durable improvement and make the next move obvious.
- Anything worth keeping should become a reusable rule, checklist, playbook, or clearly named next follow-on patch.

What a good handoff back to me looks like:
- I can see the problem clearly.
- I can see the path forward clearly.
- I know how we will measure whether this helped.
- Future-you can continue from this patch without starting over.
- ${SELF_IMPROVEMENT_HANDOFF_GUARD}
- ${SELF_IMPROVEMENT_FINAL_BLOCK}
`;
}

function ensure(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function buildTasks() {
	const tasks = [];
	const recommendedStartingPatches = [];
	let sequence = 1;

	for (const discipline of DISCIPLINES) {
		for (const wave of PATCH_WAVES) {
			discipline.foci.forEach((entry, focusIndex) => {
				const id = `sip-${String(sequence).padStart(4, "0")}`;
				const zone = entry.zone ?? discipline.defaultZone;
				const starter = wave.id === "patch-01" && focusIndex === discipline.starterFocusIndex;
				const title = `Patch ${String(wave.number).padStart(2, "0")} / ${discipline.label} / ${entry.title}`;
				const task = {
					id,
					sequence,
					title,
					discipline: discipline.label,
					disciplineSlug: discipline.slug,
					disciplineDescription: discipline.description,
					patchWave: wave.id,
					patchWaveNumber: wave.number,
					patchWaveLabel: `Patch ${String(wave.number).padStart(2, "0")} - ${wave.label}`,
					patchDirective: wave.directive,
					focusArea: entry.title,
					gap: entry.gap,
					artifact: entry.artifact,
					successMetric: entry.metric,
					priority: entry.priority,
					zone,
					starter,
				};
				task.operatorBrief = `Take point on ${entry.title.toLowerCase()} in ${discipline.label}. First ${wave.directive}, then hand back the clearest weakness, the smallest durable improvement, and the next patch.`;
				task.operatorPrompt = renderOperatorPrompt(task);
				task.structuredPrompt = renderStructuredPrompt(task);
				task.prompt = task.operatorPrompt;
				tasks.push(task);
				if (starter) recommendedStartingPatches.push(id);
				sequence++;
			});
		}
	}

	return { tasks, recommendedStartingPatches };
}

function buildMarkdown(manifest) {
	const { metadata, tasks } = manifest;
	const tasksByDiscipline = new Map();
	for (const discipline of DISCIPLINES) {
		tasksByDiscipline.set(
			discipline.slug,
			tasks.filter((task) => task.disciplineSlug === discipline.slug),
		);
	}

	const starterTasks = metadata.recommendedStartingPatches
		.map((id) => tasks.find((task) => task.id === id))
		.filter(Boolean);

	const lines = [
		"# Zaraa Self-Improvement Prompt Set — 750 Novel Tasks",
		"",
		"## Objective",
		"",
		"Create a durable self-improvement queue for Zaraa that covers 15 disciplines, 5 patch waves per discipline, and exactly 750 tasks total.",
		"The default task voice is now operator voice, so each prompt reads like a human operator handing work to Zaraa rather than an internal system scaffold.",
		"",
		"## Coverage",
		"",
		`- Total tasks: ${metadata.totalTasks}`,
		`- Total disciplines: ${metadata.disciplineCount}`,
		`- Patch waves: ${metadata.patchWaveCount}`,
		`- Tasks per discipline: 50`,
		`- Tasks per patch wave across the full set: 150`,
		"",
		"| Discipline | Tasks | Starter Patch |",
		"| --- | ---: | --- |",
		...DISCIPLINES.map((discipline) => {
			const disciplineTasks = tasksByDiscipline.get(discipline.slug) ?? [];
			const starter = disciplineTasks.find((task) => task.starter);
			return `| ${discipline.label} | ${disciplineTasks.length} | ${starter?.id ?? "n/a"} - ${starter?.focusArea ?? "n/a"} |`;
		}),
		"",
		"## Patch Waves",
		"",
		...PATCH_WAVES.map(
			(wave) =>
				`- ${wave.id}: ${wave.label} — ${wave.directive}.`,
		),
		"",
		"## Starter Pack",
		"",
		"These 15 tasks are the recommended first pass so Zaraa begins receiving patches immediately without having to rank the entire 750-task backlog first.",
		"",
		...starterTasks.flatMap((task) => [
			`### ${task.id} — ${task.title}`,
			"",
			`- Discipline: ${task.discipline}`,
			`- Priority: ${task.priority}`,
			`- Zone: ${task.zone}`,
			`- Operator brief: ${task.operatorBrief}`,
			"",
			"```text",
			task.operatorPrompt.trimEnd(),
			"```",
			"",
		]),
		"## Full Index",
		"",
		"The full prompt bodies live in `docs/runbooks/zaraa-self-improvement-750.json`. The index below makes every task visible at a glance while keeping this file skimmable.",
		"",
	];

	for (const discipline of DISCIPLINES) {
		const disciplineTasks = tasksByDiscipline.get(discipline.slug) ?? [];
		lines.push(`## ${discipline.label} (${disciplineTasks.length} tasks)`);
		lines.push("");
		lines.push(discipline.description);
		lines.push("");
		for (const wave of PATCH_WAVES) {
			const waveTasks = disciplineTasks.filter((task) => task.patchWave === wave.id);
			lines.push(`### ${wave.label} (${waveTasks.length})`);
			lines.push("");
			for (const task of waveTasks) {
				lines.push(
					`- ${task.id} | ${task.focusArea} | priority=${task.priority} | zone=${task.zone}`,
				);
			}
			lines.push("");
		}
	}

	lines.push("## Usage");
	lines.push("");
	lines.push(
		"- Regenerate artifacts: `node scripts/generate-self-improvement-750.mjs`",
	);
	lines.push(
		"- Preview the starter pack in operator voice: `node scripts/submit-self-improvement-patches.mjs --starter --dry-run --preview=full`",
	);
	lines.push(
		"- Submit the starter pack: `node scripts/submit-self-improvement-patches.mjs --starter`",
	);
	lines.push(
		"- Submit a single discipline starter patch: `node scripts/submit-self-improvement-patches.mjs --starter --discipline=security-privacy`",
	);
	lines.push(
		"- Preview or submit a full wave: `node scripts/submit-self-improvement-patches.mjs --wave=1`",
	);
	lines.push(
		"- Send the structured fallback voice instead of operator voice: `node scripts/submit-self-improvement-patches.mjs --wave=1 --voice=structured`",
	);
	lines.push("");
	lines.push(`Generated at: ${metadata.generatedAt}`);
	lines.push("");

	return `${lines.join("\n")}\n`;
}

function main() {
	mkdirSync(OUTPUT_DIR, { recursive: true });
	const generatedAt = new Date().toISOString();
	const { tasks, recommendedStartingPatches } = buildTasks();

	ensure(tasks.length === 750, `Expected 750 tasks, got ${tasks.length}`);
	ensure(new Set(tasks.map((task) => task.discipline)).size >= 12, "Expected at least 12 disciplines");
	ensure(
		DISCIPLINES.every(
			(discipline) =>
				tasks.filter((task) => task.disciplineSlug === discipline.slug).length === 50,
		),
		"Each discipline must have exactly 50 tasks",
	);
	ensure(
		PATCH_WAVES.every(
			(wave) => tasks.filter((task) => task.patchWave === wave.id).length === 150,
		),
		"Each patch wave must have exactly 150 tasks",
	);
	ensure(
		recommendedStartingPatches.length === DISCIPLINES.length,
		"Starter pack should contain exactly one task per discipline",
	);

	const metadata = {
		generatedAt,
		totalTasks: tasks.length,
		disciplineCount: DISCIPLINES.length,
		patchWaveCount: PATCH_WAVES.length,
		defaultVoice: "operator",
		recommendedStartingPatches,
		disciplines: DISCIPLINES.map((discipline) => ({
			slug: discipline.slug,
			label: discipline.label,
			description: discipline.description,
			defaultZone: discipline.defaultZone,
			taskCount: 50,
			starterPatchId: recommendedStartingPatches.find((id) =>
				tasks.some(
					(task) =>
						task.id === id &&
						task.disciplineSlug === discipline.slug &&
						task.starter,
				),
			),
		})),
		patchWaves: PATCH_WAVES.map((wave) => ({
			id: wave.id,
			number: wave.number,
			label: wave.label,
			directive: wave.directive,
			taskCount: 150,
		})),
	};

	const manifest = { metadata, tasks };
	writeFileSync(JSON_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	writeFileSync(MD_PATH, buildMarkdown(manifest), "utf8");

	console.log(`Generated ${tasks.length} tasks across ${DISCIPLINES.length} disciplines.`);
	console.log(`JSON: ${JSON_PATH}`);
	console.log(`Markdown: ${MD_PATH}`);
	console.log(`Starter patches: ${recommendedStartingPatches.length}`);
}

main();
