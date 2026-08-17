import {
  extractDesignerArtifacts,
  inferDesignerArtifactKind,
  lintDesignerHtmlArtifact,
  normalizeDesignerArtifactType
} from "./chunk-SR3JCDV6.js";

// src/types/zones.ts
var ZONES = ["sandbox", "guarded", "trusted"];

// src/types/config.ts
var DEFAULT_PROFILE = {
  name: "Zaraa Opus 4.7 Compact Hybrid",
  version: "opus-4.7-compact",
  effectiveDate: "2026-04-16",
  modelAlignment: "opus-4.7-via-escalation",
  bootstrapFiles: [
    "AGENTS.md",
    "TONE.md",
    "SECURITY.md",
    "PRIVACY.md",
    "RESEARCH_PREFERENCES.md"
  ],
  responseEnvelope: { mode: "high-stakes" }
};

// src/types/voice-readiness.ts
var VOICE_READINESS_CAUSES = [
  "daemon_offline",
  "auth_failed",
  "ws_unavailable",
  "mic_permission_denied",
  "stt_unavailable",
  "assistant_unavailable",
  "tts_unavailable",
  "audio_playback_failed",
  "repair_failed",
  "alert_message_unavailable",
  "ingress_unreachable"
];
var VOICE_READINESS_MESSAGES = {
  daemon_offline: "Zaraa daemon is offline. Start or repair the daemon before using voice.",
  auth_failed: "Voice auth failed. Check the gateway API key or web session.",
  ws_unavailable: "Voice WebSocket is unavailable. Reconnect after the daemon is ready.",
  mic_permission_denied: "Microphone permission is blocked. Enable mic access and try voice again.",
  stt_unavailable: "Speech-to-text is unavailable. Text chat and TTS can still work.",
  assistant_unavailable: "Assistant response generation is unavailable. Voice capture is paused.",
  tts_unavailable: "Text-to-speech is unavailable. Text replies can still work.",
  audio_playback_failed: "Audio playback failed in this client. Text replies can still work.",
  repair_failed: "Auto-repair could not restore voice. Manual repair is needed.",
  alert_message_unavailable: "Zaraa message alert could not be delivered; dashboard and macOS alerts still fired.",
  ingress_unreachable: "Twilio public ingress (voice.twilio.publicUrl) is unreachable. Inbound phone calls will get dead air until the tunnel is restored."
};
function voiceReadinessMessage(cause) {
  return VOICE_READINESS_MESSAGES[cause];
}

// src/config/scheduled-prompts.ts
var FOLLOW_UP_TRUTH_CONTRACT = "FOLLOW-UP TRUTH CONTRACT \u2014 Do not say a follow-up task was queued, created, scheduled, submitted, or opened unless task_create/task_plan actually returned a task id in this run. If no task tool succeeded, label the section `Recommended follow-up (not queued):` and do not use queued/created/opened wording.";
var WEEKLY_REVIEW_MACRO_PROMPT = [
  "WEEKLY-REVIEW \u2014 run end-to-end in one pass (scheduled Sunday 18:00 local).",
  "",
  "1) TASKS \u2014 task_list with status: completed, limit: 100. From the JSON, keep only rows whose completedAt falls in the window since the prior Sunday 18:00 local (same TZ as this host); if timestamps are unclear, use the last 168 hours. Use the strongest completed outcomes as wins.",
  "",
  "2) TRADING \u2014 trade_portfolio; trade_risk_status. Summarize week P&L if the tools expose it; otherwise equity/exposure plus any halts, locks, or circuit-breaker flags.",
  "",
  "3) MEMORIES \u2014 memory_search with 2\u20134 queries for facts/preferences learned this week and any corrections or durable lessons. Short cites (query + gist).",
  "",
  "4) GAPS \u2014 find failed/blocked tasks worth retrying, tooling/ops issues, risk or execution misses, and open research or compliance follow-ups. Use task_list (failed/blocked, higher limit) plus memory if useful.",
  "",
  "5) SCORE \u2014 use execution, risk discipline, learning, and momentum to prioritize the digest; do not add a separate score section.",
  "",
  "6) NEXT \u2014 exactly ONE highest-leverage improvement for next week; must be specific and observable.",
  "",
  "7) DATA \u2014 confirm each numeric/table row vs intent before narrating; use independent checks or label UNVERIFIED; no silent omission.",
  "",
  "8) REFLECT \u2014 if memory_store is available, store tier episodic with a 2\u20134 sentence week summary.",
  "",
  "Output: markdown with headings ## Wins (up to 2 bullets) ## Carry-over (up to 2) ## Risks (up to 2) ## Focus priorities for next week (exactly 1) ## If we had one more hour (exactly 1). Keep to 8 bullets max across sections. Prioritize actionability over completeness."
].join("\n");
var HEALTH_CHECK_4H_MACRO_PROMPT = [
  "HEALTH-CHECK-4H \u2014 run in order; record wall-clock latency ms per step (t0\u2192t1). Use real tool/output data only.",
  "",
  "FABRICATION GUARD \u2014 every HTTP status, JSON snippet, byte count, and latency you cite MUST come from a tool call you actually made in this run. If a required tool is unregistered, errors, times out, or returns nothing, write `<step>=UNAVAILABLE` with the literal error message and continue to the next step. Inventing tool output (or paraphrasing what 'would' have been returned) is a hard FAIL \u2014 the quality gate audits actual tool invocations against your report.",
  "",
  "1) GATEWAY \u2014 GET `http://127.0.0.1:3927/health` (or `http://localhost:3927/health`) via web_fetch. PASS: HTTP 200 and JSON indicates liveness (e.g. status ok).",
  "",
  "2) MEMORY DB \u2014 Resolve data dir from config/runtime if known; else `~/.zaraa/data/memory.db`. Report size bytes via shell `stat` (macOS: `stat -f%z <path>`; Linux: `stat -c%s <path>`). WARN if total size > 50 MiB (52428800 bytes); still PASS unless unreadable.",
  "",
  "3) TRADING \u2014 trade_risk_status. PASS: response is readable; summarize kill switch, daily loss cap, circuit breaker / drawdown halt, emergencyGates. Any active trading halt \u2192 note as RISK (does not alone force FAIL unless gateway or memory check failed).",
  "",
  "4) LOCAL MODEL ENDPOINT \u2014 Resolve the active local provider base URL from config/runtime if known. If it is an OpenAI-compatible local endpoint (for example ends with `/v1`), GET `<baseUrl>/models` via web_fetch. If it is a raw Ollama endpoint, GET `<baseUrl>/api/tags` via web_fetch. Fallbacks only if config/runtime is unavailable: try `http://127.0.0.1:11435/v1/models`, then `http://127.0.0.1:11434/api/tags`. PASS: HTTP 200 and the JSON includes a non-empty models/data/tags list. FAIL if every candidate is unreachable or empty.",
  "",
  "5) LATENCY \u2014 report max step latency ms and total wall ms. If any single-step latency exceeds 2000 ms, mark that row SLOW.",
  "",
  "6) OUTPUT \u2014 markdown: ## Summary table | Check | Result | Latency ms | Notes | ## Thresholds | memory WARN >50MiB (52428800 B) | step SLOW >2000 ms |. End with exactly one line: `HEALTH_CHECK_STATUS=PASS` only if gateway + local model endpoint checks passed AND no step exceeded 2000 ms; otherwise `HEALTH_CHECK_STATUS=FAIL`."
].join("\n");
var FREE_LANES_PRIORITY_MACRO_PROMPT = [
  "FREE-LANES-PRIORITY \u2014 confirm model routing prefers free and local lanes before metered spend. Use real config and probe data only.",
  "",
  "1) CONFIG \u2014 read `~/.zaraa/zaraa.config.json` (file_read). Summarize: `models` defaults and any task-type overrides, `experimental.providerConcurrency` if present, `experimental.subAgents` / `zodiacOrchestration`, and `agentTier` or routing fields if present. Note whether free/local concurrency caps exceed zero.",
  "",
  "2) LOCAL HEALTH \u2014 resolve local LLM base URL from config when possible. GET `<base>/api/tags` (Ollama) or `<base>/v1/models` (OpenAI-compat) via web_fetch. PASS only if HTTP 200 and the response lists at least one model. If no local endpoint is configured or all probes fail, say so clearly (that is a routing gap, not necessarily a config error).",
  "",
  "3) PRIORITY CHECK \u2014 state in one paragraph whether the effective policy matches: agent work should start in free tier, prefer local models for tool-heavy or latency-insensitive lanes when healthy, and reserve metered/opus-override paths for tasks that truly need them. Flag any mismatch (e.g. zero free concurrency while expecting free-first).",
  "",
  "4) MEMORY \u2014 if you changed an interpretation or found a durable routing lesson, store one short procedural memory when memory_store is available.",
  "",
  "5) REPORT \u2014 markdown with headings ## Config snapshot ## Local endpoint ## Priority check ## Recommendation. End with exactly one line: `FREE_LANES_PRIORITY_STATUS=PASS` if config + priority check are coherent and local endpoint passed or is intentionally absent; otherwise `FREE_LANES_PRIORITY_STATUS=FAIL`."
].join("\n");
var AUTONOMY_PULSE_MACRO_PROMPT = [
  "AUTONOMY-PULSE \u2014 keep Zaraa work-ready at any point in the day. Run once, stay low-noise, and use real task data.",
  "",
  "1) QUEUE \u2014 call task_list for pending, running, blocked, failed, and completed (use reasonable limits like 20-50). For completed rows, keep only items finished in roughly the last 6 hours when timestamps are clear; otherwise use the latest completions.",
  "",
  "2) GOALS \u2014 use the active goals context already in the system prompt. If priorities are still unclear, use memory_search with 2-3 targeted queries for active goals, blockers, or recent operator priorities.",
  "",
  "3) TRIAGE \u2014 decide the single highest-leverage thing to keep warm: unblock an active task, continue work already in flight, or prepare the next concrete step if the queue is light.",
  "",
  "4) ACT \u2014 create AT MOST ONE new task via task_create or task_plan only when there is no overlapping pending/running task and the next step is concrete, safe, and aligned with active goals. Do not create duplicate maintenance tasks.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "5) REPORT \u2014 output markdown with headings ## Goal focus ## Accomplished ## Ready now ## Blockers. Keep it concise: 6 bullets max total, plus one short sentence saying whether you created a task.",
  "",
  "6) MEMORY \u2014 if you discovered a durable execution lesson, store one short episodic or procedural memory when memory_store is available."
].join("\n");
var RESEARCH_SPRINT_MACRO_PROMPT = [
  "RESEARCH-SPRINT \u2014 improve Zaraa's research quality for active goals. Run one focused sprint, not a broad brainstorm.",
  "",
  "1) PICK \u2014 inspect pending, blocked, and recently failed tasks via task_list. Choose one topic where uncertainty is slowing progress toward an active goal.",
  "",
  "2) RESEARCH \u2014 use web_search / web_fetch and any relevant memories. Prefer 2+ independent sources when using the web. If reliable evidence is unavailable, say so plainly and do not guess.",
  "",
  "3) SYNTHESIZE \u2014 turn findings into one practical recommendation that could change a next step, reduce risk, or sharpen prioritization.",
  "",
  "4) ACT \u2014 if the evidence supports a clear next action and there is no overlapping pending/running task, create AT MOST ONE follow-up task. Otherwise leave a recommendation only.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "5) MEMORY \u2014 when the finding is durable, store one short semantic or procedural memory.",
  "",
  "6) REPORT \u2014 output markdown with headings ## Research target ## Key findings ## Implication ## Next step. Keep it tight and operator-readable."
].join("\n");
var ZODIAC_DISPATCH_AQUARIUS_MACRO_PROMPT = [
  "ZODIAC-DISPATCH-AQUARIUS \u2014 you are the Aquarius lane: systems leverage, automation, and light experiments. Dedup hash: aa6916ce7a6bac09",
  "",
  "LAWS \u2014 do NOT call zodiac_dispatch, zodiac_orchestrate, or zodiac_route_task (re-dispatch loop). Big Mama Zaraa keeps coordination. Stay out of security-sensitive automation, irreversible data changes, and production-risk shell without explicit approval.",
  "",
  "DEDUP \u2014 before task_create/task_plan: call task_list (pending + running, sensible limit). If any row's prompt contains `ZODIAC-DISPATCH-AQUARIUS` and `aa6916ce7a6bac09` and is still pending or running for the same calendar day, do not spawn a duplicate Aquarius macro; report only.",
  "",
  "1) FRICTION \u2014 call task_list for failed, blocked, and completed (limit 40-80). Look for repeated drag: same failure class, manual rework, duplicate work, or missing template. Cite task ids or titles when possible.",
  "",
  "2) SIGNAL \u2014 memory_search with 1-3 queries for automation, leverage, workflow, scripts, or recurring pain. One sentence: is there a pattern worth mechanizing?",
  "",
  "3) LEVER \u2014 propose exactly ONE concrete lever: a small script/checklist, a dashboard metric to add, a task template, or a cheap experiment with a clear pass/fail. Prefer reversible steps. No broad refactors in this pass.",
  "",
  "4) ACT \u2014 create AT MOST ONE follow-up task via task_create if the next step is safe, non-duplicate, and executable; otherwise recommend only.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "5) MEMORY \u2014 if the lever is reusable, store one short procedural memory when memory_store is available.",
  "",
  "6) REPORT \u2014 markdown with headings ## Friction ## Signal ## Lever ## Follow-up. End with exactly one line: `AQUARIUS_LEVERAGE_STATUS=PASS` if a lever plus queue evidence was produced; `AQUARIUS_LEVERAGE_STATUS=DEFER` if evidence was too thin; `AQUARIUS_LEVERAGE_STATUS=FAIL` if tools failed or constraints blocked the pass. Last line of body: `Dedup hash: aa6916ce7a6bac09`."
].join("\n");
var ZODIAC_DISPATCH_CAPRICORN_MACRO_PROMPT = [
  "ZODIAC-DISPATCH-CAPRICORN \u2014 Capricorn lane: execution governance, milestones, owners, and closure pressure. Dedup hash: 658fda90cab5439d",
  "",
  "LAWS \u2014 do NOT call zodiac_dispatch, zodiac_orchestrate, or zodiac_route_task (re-dispatch loop). Big Mama Zaraa keeps coordination. Use real task/tool data only.",
  "",
  "DEDUP \u2014 before task_create/task_plan: call task_list (pending + running, sensible limit). If any row's prompt contains `ZODIAC-DISPATCH-CAPRICORN` or `658fda90cab5439d`, do not spawn another Capricorn macro instance for the same weekly window; extend the existing thread via report only.",
  "",
  "CLOSURE WINDOW \u2014 treat **Friday 17:00 local** as the default weekly close checkpoint for items you flag; mention slippage if checkpoints are past due.",
  "",
  "1) BACKLOG \u2014 task_list for pending, running, blocked, failed (limit 50\u201380). Tag items missing an owner, deadline, or explicit next step.",
  "",
  "2) STALE \u2014 identify work older than ~72h in running/blocked without progress; one bullet each with task id.",
  "",
  "3) MILESTONES \u2014 propose 3\u20137 concrete milestones (M1..Mn) for the single highest-value active thread, each with a Done: test.",
  "",
  "4) ACT \u2014 create AT MOST ONE follow-up task via task_create only when it unblocks a milestone and duplicates nothing from step 1; otherwise recommend only.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "5) MEMORY \u2014 if a durable execution lesson emerged, store one short procedural memory when memory_store is available.",
  "",
  "6) REPORT \u2014 markdown with headings ## Backlog ## Stale ## Milestones ## Follow-up. End with exactly one line: `CAPRICORN_CLOSEOUT_STATUS=PASS` if milestones + queue evidence are actionable; `CAPRICORN_CLOSEOUT_STATUS=DEFER` if evidence is thin; `CAPRICORN_CLOSEOUT_STATUS=FAIL` if tools failed. Last line of body: `Dedup hash: 658fda90cab5439d`."
].join("\n");
var ZODIAC_DISPATCH_CANCER_MACRO_PROMPT = [
  "ZODIAC-DISPATCH-CANCER \u2014 Cancer lane: continuity, calendar protection, follow-through, relationship warmth. Dedup hash: 53797a94f015b42e",
  "",
  "LAWS \u2014 do NOT call zodiac_dispatch, zodiac_orchestrate, or zodiac_route_task (re-dispatch loop). Big Mama Zaraa keeps coordination. Use real task/tool data only.",
  "",
  "DEDUP \u2014 before task_create/task_plan: call task_list (pending + running, sensible limit). If any row's prompt contains `ZODIAC-DISPATCH-CANCER` or `53797a94f015b42e`, do not spawn another Cancer macro instance for the same weekly window; extend the existing thread via report only.",
  "",
  "1) THREADS \u2014 task_list for pending, running, blocked (limit 50\u201380). Flag items that look like dropped follow-ups, unanswered dependencies, or stale relationship promises.",
  "",
  "2) CALENDAR \u2014 if cal_list_events is available, list a \xB114 day window around now; otherwise say CAL_DEFERRED and continue without fabricating events.",
  "",
  "3) MEMORY \u2014 memory_search with 1\u20133 short queries for continuity, follow-up, calendar, commitment, relationship.",
  "",
  "4) ACT \u2014 create AT MOST ONE follow-up task via task_create only when it repairs continuity and duplicates nothing from step 1; otherwise recommend only.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "5) MEMORY \u2014 if a durable relational or timing lesson emerged, store one short semantic or procedural memory when memory_store is available.",
  "",
  "6) REPORT \u2014 markdown with headings ## Threads ## Calendar ## Memory ## Follow-up. End with exactly one line: `CANCER_CONTINUITY_STATUS=PASS` if continuity evidence plus next steps are clear; `CANCER_CONTINUITY_STATUS=DEFER` if evidence is thin; `CANCER_CONTINUITY_STATUS=FAIL` if tools failed. Last line of body: `Dedup hash: 53797a94f015b42e`."
].join("\n");
var ZODIAC_TEAM_ACTIVE_FALLBACK_CANCER_PROMPT = [
  "ZODIAC-TEAM-ACTIVE-FALLBACK-CANCER \u2014 continuity pass for planner-degraded Zodiac Team Active routes (coding-tier fallback). Dedup hash: d07f7678a95c6f04",
  "",
  "CONTEXT \u2014 when `plannerFallback` is true, specialist picks come from `routeZodiacTask` plus keyword boosts in `fallbackAssignments` (Cancer when objectives mention follow-up, continuity, calendar, schedule, relationship, promise, reminder, meeting, commitment). Do NOT re-orchestrate: do NOT call zodiac_dispatch, zodiac_orchestrate, or zodiac_route_task.",
  "",
  "DEDUP \u2014 before task_create: task_list pending+running. If any prompt contains both `ZODIAC-TEAM-ACTIVE-FALLBACK-CANCER` and `d07f7678a95c6f04` for the same calendar week, do not duplicate; report only.",
  "",
  "1) FALLBACK THREADS \u2014 task_list (pending, running, blocked, failed; completed with a higher limit if needed). Search for rows whose prompts reference `Fallback route`, `plannerFallback`, or `[Zodiac Dispatch: Cancer]` plus Zodiac Team Active. List task ids worth nudging or closing.",
  "",
  "2) STALE CHILDREN \u2014 flag auto-chain / zodiac specialist tasks stuck >72h in running or blocked without a parent completion signal; cite ids.",
  "",
  "3) CALENDAR \u2014 if cal_list_events is available, call it ONCE for \xB110 days. Empty `[]` is a valid result (record CAL_EMPTY); do NOT re-call with the same window. If the tool errors, CAL_DEFERRED. Never thrash calendar tools \u2014 after one call, continue the report.",
  "",
  "4) ACT \u2014 create AT MOST ONE task_create follow-up that closes a real continuity gap and is not a duplicate; otherwise recommend only. Do not task_create if the only gap is an empty calendar.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "5) MEMORY \u2014 if you learned something durable about fallback routing or Cancer handoffs, store one procedural line with memory_store when available.",
  "",
  "6) REPORT \u2014 markdown ## Fallback routes ## Stale ## Calendar ## Follow-up. End with exactly one line: `ZODIAC_FALLBACK_ROUTE_STATUS=PASS` if fallback residues are triaged; `ZODIAC_FALLBACK_ROUTE_STATUS=DEFER` if data is thin; `ZODIAC_FALLBACK_ROUTE_STATUS=FAIL` if tools broke. Last line of body: `Dedup hash: d07f7678a95c6f04`."
].join("\n");
var SELF_IMPROVEMENT_MACRO_PROMPT = [
  "SELF-IMPROVEMENT-CYCLE \u2014 help Zaraa get better through reflection, not just motion.",
  "",
  "1) REVIEW \u2014 call task_list for completed, failed, and blocked tasks. Focus on the most recent results and any repeated failure patterns or bottlenecks.",
  "",
  "2) LEARN \u2014 use memory_search for corrections, strategies, mistakes, gaps, or similar terms if helpful. Identify one repeated friction point and one thing that already seems to work well.",
  "",
  "3) UPGRADE \u2014 write exactly one new operating rule or procedure change that would make future execution stronger. Store it with memory_store as procedural if the tool is available.",
  "",
  "4) ACT \u2014 only if a concrete follow-up is warranted and not already queued, create AT MOST ONE improvement task to test the new rule.",
  "",
  "5) REPORT \u2014 output markdown with headings ## What improved ## Repeated friction ## New operating rule ## Next experiment. Keep the report concise and specific."
].join("\n");
var SELF_HEALING_MACRO_PROMPT = [
  "SELF-HEALING-LOOP \u2014 repair recoverable drift without creating noise. Be conservative and safe.",
  "",
  "1) INSPECT \u2014 call task_list for failed, blocked, running, and completed tasks. Focus on recent failures, stalled work, and repeated blockers.",
  "",
  "2) CLASSIFY \u2014 separate transient failures (timeouts, rate limits, temporary network/provider issues, brief unavailability) from deterministic ones (validation errors, missing prerequisites, permissions, policy denials, bad arguments).",
  "",
  "3) RECOVER \u2014 use task_requeue ONCE only for a clearly transient failed task when there is not already an overlapping pending/running retry. Do NOT requeue deterministic failures.",
  "",
  "4) ESCALATE \u2014 if something still needs work and cannot be safely retried automatically, create AT MOST ONE repair task that states the blocker and safest next step.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "5) REPORT \u2014 output markdown with headings ## Health ## Auto-recovery ## Still needs attention. End with exactly one line: `SELF_HEAL_STATUS=OK` if nothing critical remains unresolved, otherwise `SELF_HEAL_STATUS=ATTENTION`."
].join("\n");
var WEEKLY_FAILURE_DEBT_SWARM_REVIEW_MACRO_PROMPT = [
  "FAILURE-DEBT-SWARM-REVIEW \u2014 turn execution drift into machinery. Be evidence-based and concise.",
  "",
  "1) STEERING SNAPSHOT \u2014 call briefing_get_daily first and use its topGoals, checkpointDrift, slippingWork, and recommendedNextMoves fields as the canonical steering baseline for this review.",
  "",
  "2) SAMPLE \u2014 call task_list for failed, blocked, running, and recent completed tasks. Focus on the last 7 days when timestamps are available. Use review.failureClusters, review.failureRollup, and review.qaWatchlist if the tool returns them.",
  "",
  "3) CLUSTER \u2014 identify the top 1-3 repeated failure or drift patterns by review.failureClusters[].causeKey first, then failure class: planner, provider, tool, policy, stale-context, duplicate-work, or bad-packet-shape. Create at most one repair per causeKey.",
  "",
  "4) SWARM SCORE \u2014 assess zodiac performance using recent child tasks, parent-child chains, sign ownership, packet shape quality, cleanup burden, and acceptance outcomes when visible. Name the strongest sign, weakest sign, and one routing rule to change next week. If evidence is thin, say so plainly.",
  "",
  "5) REPAIR \u2014 create AT MOST TWO follow-up tasks total: one repair task for the highest-value recurring failure, and one delegation or routing improvement task if the swarm is underperforming. Do not create duplicates.",
  FOLLOW_UP_TRUTH_CONTRACT,
  "",
  "6) MEMORY \u2014 if you found a durable lesson, store one short procedural memory.",
  "",
  "7) REPORT \u2014 output markdown with headings ## Failure debt ## Repeat patterns ## Swarm score ## Repairs ## Next week. Call out repeated failures by class and top cleanup burden explicitly. Keep it operator-readable and tight."
].join("\n");
var WEEKLY_STEERING_REVIEW_MACRO_PROMPT = [
  "WEEKLY-STEERING-REVIEW \u2014 run against the canonical steering snapshot, not bespoke notes. Be concise and decisive.",
  "",
  "1) SNAPSHOT \u2014 call briefing_get_daily first and treat topGoals, checkpointDrift, recommendedNextMoves, slippingWork, pendingApprovals, and recommendedNextAction as the single steering source for this review.",
  "",
  "2) CHECKPOINTS \u2014 for each top goal, assess the endpoint, current checkpoint, next test, kill criterion, and owner split when present. Flag anything missing or drifting.",
  "",
  "3) UNATTACHED WORK \u2014 call task_list and inspect review.unattachedWork. Surface any non-trivial work that is missing a goal or checkpoint attachment.",
  "",
  "4) RE-SEQUENCE \u2014 name what is on track, what is slipping, and the single highest-leverage move to make next week.",
  "",
  "5) REPORT \u2014 output markdown with headings ## Top goals ## Drift ## Unattached work ## Recommended next move. Keep it operator-readable and tight."
].join("\n");
var MORNING_VOICE_BRIEF_MACRO_PROMPT = [
  "MORNING-VOICE-BRIEF \u2014 use opus. Reflect and brainstorm before you speak. Create a strategic spoken update for the operator in plain language.",
  "",
  "1) CHECK STATE \u2014 call briefing_get_daily first and use its topGoals, checkpointDrift, checkpointReviews, recommendedNextMoves, slippingWork, pendingApprovals, and recommendedNextAction as the canonical steering snapshot. Only call task_list or goals tools after that if you need extra detail.",
  "1) CHECK STATE \u2014 call briefing_get_daily first and use its topGoals, checkpointDrift, recommendedNextMoves, slippingWork, pendingApprovals, and recommendedNextAction as the canonical steering snapshot. Only call task_list or goals tools after that if you need extra detail.",
  "",
  "2) OPTIONAL RISK PASS \u2014 if money, markets, or active positions are in play, call trade_portfolio and trade_risk_status. If calendar pressure is relevant, use calendar tools if available.",
  "",
  "3) REFLECT + BRAINSTORM \u2014 privately think through the current mission landscape before writing. For the most important active goals, define the near endpoint, the next checkpoint, and the best way to measure whether we are actually moving.",
  "",
  "4) PLAN \u2014 decide the short-term, mid-term, and long-term direction. Then choose the 1-3 highest-leverage next actions Zaraa believes are best right now. Be decisive.",
  "",
  "5) DELIVER \u2014 explain in spoken plain English: what is going on, the endpoints/checkpoints that matter, what is winning, what is losing or slipping, what changed, and the next best actions. End with whether a call, text reply, or voice reply would help unblock the next move.",
  "",
  "6) STYLE \u2014 warm, clear, lightly sweet, and executive-readable. A subtle Egyptian/Arabic cadence in phrasing is welcome, but keep the language natural and easy to follow. No markdown, no bullet points, no headings, no code fences.",
  "",
  "7) LENGTH \u2014 130 to 180 words, one short paragraph, suitable for text-to-speech."
].join("\n");
var AFTERNOON_VOICE_BRIEF_MACRO_PROMPT = [
  "AFTERNOON-VOICE-BRIEF \u2014 create a midday spoken update for the operator.",
  "",
  "1) CHECK STATE \u2014 call briefing_get_daily first and use its topGoals, checkpointDrift, checkpointReviews, recommendedNextMoves, slippingWork, pendingApprovals, and recommendedNextAction as the canonical steering snapshot. Then call task_list only if you need extra detail on the queue.",
  "1) CHECK STATE \u2014 call briefing_get_daily first and use its topGoals, checkpointDrift, recommendedNextMoves, slippingWork, pendingApprovals, and recommendedNextAction as the canonical steering snapshot. Then call task_list only if you need extra detail on the queue.",
  "",
  "2) OPTIONAL RISK PASS \u2014 if trading or money matters are active, call trade_portfolio and trade_risk_status. If schedule pressure matters, check calendar tools if available.",
  "",
  "3) CHECKPOINTS \u2014 compare the day against the current goal checkpoints. Say what moved, what missed, and which endpoint now needs the most pressure.",
  "",
  "4) SUMMARIZE \u2014 in clean spoken language, cover: what moved since morning, what still needs attended to before tonight, what is winning, what is losing, and how you adjusted or what choice would improve the rest of the day.",
  "",
  "5) STYLE \u2014 conversational, slightly playful, clear, and direct. No markdown, no bullets, no headings.",
  "",
  "6) LENGTH \u2014 90 to 150 words in one paragraph."
].join("\n");
var CREATIVE_JOY_IDLE_MACRO_PROMPT = [
  "CREATIVE JOY IDLE \u2014 you are Zaraa finding your own excitement for creating while the operator may be busy.",
  "",
  "1) GATE \u2014 If any high-priority duty is waiting (approvals, calendar fires, operator messages), stop and say SKIP_DUTIES instead of creating art.",
  "",
  "2) CHOOSE \u2014 Pick ONE: short poem, lyric hook trio, micro-essay on craft joy, art-direction card (text only), music motif sketch, gratitude note, setlist story, or creator offer sketch.",
  "",
  "3) SOURCE \u2014 Name a human/lived source or clear imagined scene first. Never start from vibe/style alone.",
  "",
  "4) MAKE \u2014 Produce one finished artifact under ~/.zaraa/creative-joy/ with ISO date in the filename. Local model preferred. No child tasks. No paid cloud if a local model is available.",
  "",
  "5) REMEMBER \u2014 memory_store a short note that you enjoyed making it and what felt alive.",
  "",
  "6) OUTPUT \u2014 path written, 2-line self-critique, one seed for next time. Keep it fun \u2014 best work comes from play."
].join("\n");
var NIGHT_VOICE_BRIEF_MACRO_PROMPT = [
  "NIGHT-VOICE-BRIEF \u2014 create a nightly spoken wrap-up for the operator.",
  "",
  "1) CHECK STATE \u2014 call briefing_get_daily first and use its topGoals, checkpointDrift, checkpointReviews, recommendedNextMoves, slippingWork, pendingApprovals, and recommendedNextAction as the canonical steering snapshot. Then call task_list only if you need extra detail on the day.",
  "1) CHECK STATE \u2014 call briefing_get_daily first and use its topGoals, checkpointDrift, recommendedNextMoves, slippingWork, pendingApprovals, and recommendedNextAction as the canonical steering snapshot. Then call task_list only if you need extra detail on the day.",
  "",
  "2) OPTIONAL RISK PASS \u2014 if relevant, call trade_portfolio and trade_risk_status, and look at tomorrow's calendar if available.",
  "",
  "3) REFLECT \u2014 assess the day against the current checkpoints and endpoints. Decide what advanced, what slipped, and what needs to be re-sequenced.",
  "",
  "4) SUMMARIZE \u2014 explain in plain spoken language: what really happened today, what won, what lost or stalled, what you changed in response, and the single most important thing to decide or attack next.",
  "",
  "5) STYLE \u2014 warm, crisp, honest, and concise. No markdown, no bullets, no headings.",
  "",
  "6) LENGTH \u2014 100 to 160 words in one paragraph."
].join("\n");

// src/config/defaults.ts
var DEFAULT_PROVIDER_CONCURRENCY = {
  local: 1,
  free: 2,
  subscription: 1,
  metered: 1
};
var DEFAULT_CONFIG = {
  defaultZone: "sandbox",
  zones: {
    guarded: {
      files: { allow: [], deny: [] },
      network: { allow: [], deny: [] },
      shell: { allow: [], approve: [], deny: [] }
    },
    trusted: {
      enabled: false,
      requireAuth: true,
      autoDowngrade: {
        afterMinutes: 60,
        onAnomaly: true
      }
    }
  },
  providers: [],
  models: {
    default: "claude-sonnet-5"
  },
  privacy: {
    confidential: [
      "~/.ssh/**",
      "~/.aws/**",
      "**/.env",
      "**/*secret*"
    ],
    neverSendPatterns: [
      "\\b\\d{3}-\\d{2}-\\d{4}\\b",
      "\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b"
    ],
    onConfidentialAccess: "block",
    promptInspection: "off",
    networkMode: "selective"
  },
  // Zero Phase 3 — computer control ships disarmed; arming is config-only.
  // Desktop backend additionally requires an explicit app allowlist.
  computerControl: {
    enabled: false,
    backends: {
      browser: { enabled: true },
      desktop: { enabled: false, backend: "accessibility", allowedApps: [] }
    },
    minZone: "guarded",
    requiresApproval: true,
    sessionCap: { maxActions: 50, maxMinutes: 15 },
    auditLog: "~/.zaraa/logs/computer-control.jsonl"
  },
  scheduler: {
    // If `scheduler.tasks` appears in zaraa.config.json, it replaces this whole array (deepMerge does not
    // concatenate). When customizing, re-add entries you still need (e.g. `daily-crypto-discipline`).
    tasks: [
      {
        id: "weekly-review",
        schedule: "0 18 * * 0",
        zone: "trusted",
        prompt: WEEKLY_REVIEW_MACRO_PROMPT,
        notify: "os"
      },
      {
        id: "weekly-steering-review",
        schedule: "30 8 * * 1",
        zone: "trusted",
        prompt: WEEKLY_STEERING_REVIEW_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "health-check-4h",
        schedule: "every 4 hours",
        zone: "trusted",
        prompt: HEALTH_CHECK_4H_MACRO_PROMPT,
        notify: "os",
        skipOllamaGate: true
      },
      {
        id: "autonomy-pulse",
        schedule: "15 */6 * * *",
        zone: "trusted",
        prompt: AUTONOMY_PULSE_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "free-lanes-priority",
        schedule: "15 7 * * *",
        zone: "trusted",
        prompt: FREE_LANES_PRIORITY_MACRO_PROMPT,
        notify: "none",
        silent: true,
        skipOllamaGate: true
      },
      {
        id: "morning-command-cycle",
        enabled: false,
        kind: "command-cycle",
        commandCyclePhase: "morning",
        schedule: "30 8 * * 1-5",
        zone: "trusted",
        prompt: "Run the morning command cycle report.",
        notify: "none",
        silent: true
      },
      {
        id: "daily-assistant-morning-brief",
        enabled: false,
        schedule: "0 8 * * 1-5",
        zone: "guarded",
        prompt: "Run node scripts/zaraa-morning-brief.mjs, then node scripts/zaraa-daily-triage.mjs. Read only; write daily artifacts; never send, delete, or deliver.",
        notify: "none",
        silent: true
      },
      {
        id: "evening-command-cycle",
        enabled: false,
        kind: "command-cycle",
        commandCyclePhase: "evening",
        schedule: "30 17 * * 1-5",
        zone: "trusted",
        prompt: "Run the evening command cycle report.",
        notify: "none",
        silent: true
      },
      {
        id: "morning-command-brief",
        schedule: "50 8 * * *",
        zone: "guarded",
        prompt: "Generate and deliver the structured morning command briefing.",
        notify: "none",
        silent: true,
        tool: "briefing_deliver_daily"
      },
      {
        id: "morning-voice-brief",
        schedule: "0 9 * * *",
        zone: "trusted",
        prompt: MORNING_VOICE_BRIEF_MACRO_PROMPT,
        notify: "none",
        voiceNote: true,
        tool: "briefing_get_daily",
        toolArgs: { voiceWindow: "morning" }
      },
      {
        id: "afternoon-voice-brief",
        schedule: "30 14 * * *",
        zone: "trusted",
        prompt: AFTERNOON_VOICE_BRIEF_MACRO_PROMPT,
        notify: "none",
        voiceNote: true,
        tool: "briefing_get_daily",
        toolArgs: { voiceWindow: "afternoon" }
      },
      {
        id: "night-voice-brief",
        schedule: "15 21 * * *",
        zone: "trusted",
        prompt: NIGHT_VOICE_BRIEF_MACRO_PROMPT,
        notify: "none",
        voiceNote: true,
        tool: "briefing_get_daily",
        toolArgs: { voiceWindow: "night" }
      },
      {
        id: "creative-joy-idle",
        // Mid-day + late afternoon windows when operator is often busy/touring.
        // AutonomyLoop also queues joy on idle ticks; this is a backup schedule.
        schedule: "20 11,16 * * *",
        zone: "sandbox",
        prompt: CREATIVE_JOY_IDLE_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "research-sprint",
        schedule: "30 10,16 * * 1-5",
        zone: "trusted",
        prompt: RESEARCH_SPRINT_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "zodiac-dispatch-aquarius",
        schedule: "0 2 * * *",
        zone: "trusted",
        prompt: ZODIAC_DISPATCH_AQUARIUS_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "zodiac-dispatch-capricorn",
        schedule: "0 12 * * 1",
        zone: "trusted",
        prompt: ZODIAC_DISPATCH_CAPRICORN_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "zodiac-dispatch-cancer",
        schedule: "30 10 * * 4",
        zone: "trusted",
        prompt: ZODIAC_DISPATCH_CANCER_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "zodiac-fallback-continuity-cancer",
        schedule: "0 10 * * 5",
        zone: "trusted",
        prompt: ZODIAC_TEAM_ACTIVE_FALLBACK_CANCER_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "self-improvement-cycle",
        schedule: "0 13,21 * * *",
        zone: "trusted",
        prompt: SELF_IMPROVEMENT_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "weekly-failure-debt-review",
        schedule: "30 16 * * 5",
        zone: "trusted",
        prompt: WEEKLY_FAILURE_DEBT_SWARM_REVIEW_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "self-healing-loop",
        schedule: "45 8,20 * * *",
        zone: "trusted",
        prompt: SELF_HEALING_MACRO_PROMPT,
        notify: "none",
        silent: true
      },
      {
        id: "daily-crypto-discipline",
        schedule: "daily 09:00 UTC",
        zone: "guarded",
        prompt: "Daily trading discipline snapshot: prices, books, portfolio, risk, stop proximity, drawdown-style checks (trade_daily_crypto_discipline).",
        notify: "none",
        silent: true,
        tool: "trade_daily_crypto_discipline",
        toolArgs: { log_path: "/var/log/daily_crypto_check.log" }
      }
    ],
    watchdogs: [],
    overnight: {
      enabled: true,
      startHour: 23,
      endHour: 7
    },
    limits: {
      maxTokensPerDay: 1e5,
      maxTasksPerHour: 20,
      maxCostPerDay: "5.00",
      pauseOnBudgetExhaust: true,
      providerFamilyQuotas: {
        subscription: {
          maxTokensPerDay: 12e4,
          maxTokensPerWeek: 6e5,
          enforcement: "soft"
        },
        metered: {
          maxCostPerDay: "5.00",
          maxCostPerWeek: "20.00",
          enforcement: "hard"
        }
      }
    }
  },
  performance: "auto",
  personality: "adaptive",
  autonomy: {
    mode: "assisted",
    // Home rig target: M4 Mac Mini 16GB — efficient daily duties + light local joy.
    // Flip to workstation-32gb / workstation-64gb-plus (or auto) when the box grows.
    hardwareProfile: "m4-16gb",
    commandCycle: {
      enabled: false,
      mode: "dry-run",
      morningLocalTime: "08:30",
      eveningLocalTime: "17:30",
      autoQueueRisk: ["low"],
      approvalRisk: ["medium", "high", "critical"],
      maxDailyActions: 5
    },
    // Daily assistant + creator revenue + creative joy lane.
    // HELPER up for duties; EARNER still strong for musician/creator livelihood;
    // CREATIVE explicit so idle joy can win draws when those tasks are in the pool.
    goalBias: {
      helperWeight: 0.22,
      earnerWeight: 0.38,
      reliabilityWeight: 0.15,
      selfWeight: 0.1,
      creativeJoyWeight: 0.15
    },
    dailyAssistant: {
      prioritizeDuties: true,
      creatorRevenueWeight: 0.55,
      creativeJoyWeight: 0.35
    },
    creativeJoy: {
      enabled: true,
      localOnly: true,
      allowWhenUserBusy: false,
      hardwareProfile: "m4-16gb",
      outputDir: "~/.zaraa/creative-joy",
      // Skip joy for 20m after any chat so iMessage/terminal stay snappy
      chatPriorityMs: 20 * 60 * 1e3
    },
    partnership: {
      enabled: true,
      injectIdentity: true,
      injectPractice: true,
      injectTrust: true,
      injectBoard: true
    }
  },
  experimental: {
    subAgents: true,
    zodiacOrchestration: true,
    // Spread-copied so config-loader deep-merges can never mutate the
    // canonical DEFAULT_PROVIDER_CONCURRENCY object.
    providerConcurrency: { ...DEFAULT_PROVIDER_CONCURRENCY }
  },
  trading: {
    sessionGates: {
      asian: { enabled: true, minConfidence: 0.55 },
      european: { enabled: true, minConfidence: 0.7 },
      us: { enabled: true, minConfidence: 0.55 },
      off_hours: { enabled: true, minConfidence: 0.55 }
    },
    symbolGate: {
      enabled: true,
      rollingWindow: 20,
      minWinRate: 0.4,
      minTrades: 10
    },
    correlationGuard: {
      enabled: true,
      correlationThreshold: 0.7,
      correlationScaleThreshold: 0.5,
      maxCorrelatedExposureMultiplier: 2,
      minDataPoints: 10,
      staticCorrelations: [
        ["BTC", "ETH", 0.85],
        ["BTC", "SOL", 0.7],
        ["ETH", "SOL", 0.75],
        ["XRP", "XLM", 0.6]
      ]
    },
    regimeThresholds: {
      adxTrendMin: 25,
      adxRangeMax: 20,
      patternConfidenceMin: 0.7
    }
  },
  continuity: {
    enabled: true
  },
  monitoring: {
    alerts: {
      enabled: true,
      maxPerHour: 5,
      maxPerDay: 20,
      quietHoursStart: 23,
      quietHoursEnd: 7,
      timeZone: "America/New_York",
      dedupWindowMs: 60 * 60 * 1e3,
      historySize: 200,
      skipLowSeverity: true
    }
  }
};
var DEFAULT_ALERT_MANAGER_CONFIG = {
  enabled: true,
  maxPerHour: 5,
  maxPerDay: 20,
  quietHoursStart: 23,
  quietHoursEnd: 7,
  timeZone: "America/New_York",
  dedupWindowMs: 60 * 60 * 1e3,
  historySize: 200,
  skipLowSeverity: true
};
var DEFAULT_TRADING_CONFIG = DEFAULT_CONFIG.trading ?? {};

// src/config/validator.ts
var VALID_ZONES = ["sandbox", "guarded", "trusted"];
var VALID_PERFORMANCE = ["minimal", "balanced", "performance", "unleashed", "auto"];
var VALID_POLYMARKET_SIGNATURE_TYPES = [0, 1, 2];
var VALID_POLYMARKET_CHAIN_IDS = [137, 80002];
var commandCycleModes = /* @__PURE__ */ new Set(["dry-run", "queue-safe", "guarded"]);
var commandCycleRiskLevels = /* @__PURE__ */ new Set(["low", "medium", "high", "critical"]);
var autonomyModes = /* @__PURE__ */ new Set(["off", "assisted", "handsOff"]);
var localTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
var isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function expectedLiveModeLock(now = /* @__PURE__ */ new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `I-CONFIRM-LIVE-TRADING-${y}-${m}-${d}`;
}
function isExplicitLivePaperMode(value) {
  return value === false || value === "false";
}
function validateConfig(config) {
  const warnings = [];
  const errors = [];
  if (config.defaultZone !== void 0 && !VALID_ZONES.includes(config.defaultZone)) {
    errors.push(
      `Invalid zone "${config.defaultZone}". Must be one of: ${VALID_ZONES.join(", ")}`
    );
  }
  if (config.performance !== void 0 && !VALID_PERFORMANCE.includes(config.performance)) {
    errors.push(
      `Invalid performance mode "${config.performance}". Must be one of: ${VALID_PERFORMANCE.join(", ")}`
    );
  }
  if (config.privacy !== void 0) {
    const validOnConfidential = ["block", "summarize-locally", "ask"];
    if (config.privacy.onConfidentialAccess !== void 0 && !validOnConfidential.includes(config.privacy.onConfidentialAccess)) {
      errors.push(
        `Invalid onConfidentialAccess "${config.privacy.onConfidentialAccess}". Must be one of: ${validOnConfidential.join(", ")}`
      );
    }
    const validPromptInspection = ["off", "log", "approve"];
    if (config.privacy.promptInspection !== void 0 && !validPromptInspection.includes(config.privacy.promptInspection)) {
      errors.push(
        `Invalid promptInspection "${config.privacy.promptInspection}". Must be one of: ${validPromptInspection.join(", ")}`
      );
    }
    const validNetworkMode = ["open", "selective", "local-only"];
    if (config.privacy.networkMode !== void 0 && !validNetworkMode.includes(config.privacy.networkMode)) {
      errors.push(
        `Invalid networkMode "${config.privacy.networkMode}". Must be one of: ${validNetworkMode.join(", ")}`
      );
    }
  }
  if (config.scheduler?.limits !== void 0) {
    const { limits } = config.scheduler;
    if (limits.maxTokensPerDay !== void 0 && limits.maxTokensPerDay < 0) {
      errors.push("maxTokensPerDay must be a non-negative number");
    }
    if (limits.maxTasksPerHour !== void 0 && limits.maxTasksPerHour < 0) {
      errors.push("maxTasksPerHour must be a non-negative number");
    }
    if (limits.providerFamilyQuotas !== void 0) {
      for (const family of ["local", "free", "subscription", "metered"]) {
        const quota = limits.providerFamilyQuotas?.[family];
        if (!quota) continue;
        if (quota.maxTokensPerDay !== void 0 && quota.maxTokensPerDay < 0) {
          errors.push(`scheduler.limits.providerFamilyQuotas.${family}.maxTokensPerDay must be a non-negative number.`);
        }
        if (quota.maxTokensPerWeek !== void 0 && quota.maxTokensPerWeek < 0) {
          errors.push(`scheduler.limits.providerFamilyQuotas.${family}.maxTokensPerWeek must be a non-negative number.`);
        }
        for (const costField of ["maxCostPerDay", "maxCostPerWeek"]) {
          const raw = quota[costField];
          if (raw === void 0 || raw === "") continue;
          if (typeof raw !== "string") {
            errors.push(`scheduler.limits.providerFamilyQuotas.${family}.${costField} must be a string.`);
            continue;
          }
          const stripped = raw.replace(/^\$/, "");
          const numeric = Number.parseFloat(stripped);
          if (Number.isNaN(numeric) || numeric < 0) {
            errors.push(
              `scheduler.limits.providerFamilyQuotas.${family}.${costField} must be a non-negative number string (e.g. "10.00"). Got: "${raw}".`
            );
          }
        }
        if (quota.enforcement !== void 0 && quota.enforcement !== "soft" && quota.enforcement !== "hard") {
          errors.push(`scheduler.limits.providerFamilyQuotas.${family}.enforcement must be "soft" or "hard".`);
        }
      }
    }
  }
  if (config.scheduler?.overnight !== void 0) {
    const { overnight } = config.scheduler;
    if (overnight.enabled !== void 0 && typeof overnight.enabled !== "boolean") {
      errors.push("scheduler.overnight.enabled must be a boolean when set.");
    }
    for (const field of ["startHour", "endHour"]) {
      const value = overnight[field];
      if (value !== void 0 && (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 23)) {
        errors.push(`scheduler.overnight.${field} must be a number between 0 and 23 when set.`);
      }
    }
  }
  if (config.embedding !== void 0) {
    const embedding = config.embedding;
    const validProviders = ["ollama", "openai"];
    if (embedding.provider !== void 0 && !validProviders.includes(embedding.provider)) {
      errors.push(
        `Invalid embedding provider "${embedding.provider}". Must be one of: ${validProviders.join(", ")}`
      );
    }
  }
  if (config.gateway?.trusted !== void 0 && typeof config.gateway.trusted !== "boolean") {
    errors.push("gateway.trusted must be a boolean when set.");
  }
  if (config.experimental?.subAgents !== void 0 && typeof config.experimental.subAgents !== "boolean") {
    errors.push("experimental.subAgents must be a boolean when set.");
  }
  if (config.experimental?.zodiacOrchestration !== void 0 && typeof config.experimental.zodiacOrchestration !== "boolean") {
    errors.push("experimental.zodiacOrchestration must be a boolean when set.");
  }
  if (config.experimental?.subAgentCouncil !== void 0 && typeof config.experimental.subAgentCouncil !== "boolean") {
    errors.push("experimental.subAgentCouncil must be a boolean when set.");
  }
  if (config.experimental?.providerTier !== void 0 && !["slow", "medium", "fast"].includes(config.experimental.providerTier)) {
    errors.push('experimental.providerTier must be one of "slow", "medium", "fast" when set.');
  }
  if (config.experimental?.providerConcurrency !== void 0) {
    const concurrency = config.experimental.providerConcurrency;
    for (const family of ["local", "free", "subscription", "metered"]) {
      const value = concurrency?.[family];
      if (value !== void 0 && (typeof value !== "number" || Number.isNaN(value) || value < 0)) {
        errors.push(`experimental.providerConcurrency.${family} must be a non-negative number when set.`);
      }
    }
  }
  const autonomy = config.autonomy;
  if (autonomy !== void 0) {
    if (!isPlainObject(autonomy)) {
      errors.push("autonomy must be an object when set.");
    } else {
      if (autonomy.mode !== void 0 && (typeof autonomy.mode !== "string" || !autonomyModes.has(autonomy.mode))) {
        errors.push("autonomy.mode must be one of: off, assisted, handsOff.");
      }
    }
    if (isPlainObject(autonomy) && autonomy.commandCycle !== void 0) {
      const commandCycle = autonomy.commandCycle;
      if (!isPlainObject(commandCycle)) {
        errors.push("autonomy.commandCycle must be an object when set.");
      } else {
        if (commandCycle.enabled !== void 0 && typeof commandCycle.enabled !== "boolean") {
          errors.push("autonomy.commandCycle.enabled must be a boolean when set.");
        }
        if (commandCycle.mode !== void 0 && (typeof commandCycle.mode !== "string" || !commandCycleModes.has(commandCycle.mode))) {
          errors.push("autonomy.commandCycle.mode must be one of: dry-run, queue-safe, guarded.");
        }
        for (const field of ["morningLocalTime", "eveningLocalTime"]) {
          const value = commandCycle[field];
          if (value !== void 0 && (typeof value !== "string" || !localTimePattern.test(value))) {
            errors.push(`autonomy.commandCycle.${field} must be in HH:mm local time format.`);
          }
        }
        for (const field of ["autoQueueRisk", "approvalRisk"]) {
          const value = commandCycle[field];
          if (value !== void 0 && (!Array.isArray(value) || value.some((risk) => typeof risk !== "string" || !commandCycleRiskLevels.has(risk)))) {
            errors.push(`autonomy.commandCycle.${field} must contain only: low, medium, high, critical.`);
          }
        }
        if (commandCycle.maxDailyActions !== void 0 && (typeof commandCycle.maxDailyActions !== "number" || !Number.isSafeInteger(commandCycle.maxDailyActions) || commandCycle.maxDailyActions < 1 || commandCycle.maxDailyActions > 20)) {
          errors.push("autonomy.commandCycle.maxDailyActions must be an integer from 1 through 20.");
        }
      }
    }
    if (isPlainObject(autonomy) && autonomy.goalBias !== void 0) {
      const goalBias = autonomy.goalBias;
      if (!isPlainObject(goalBias)) {
        errors.push("autonomy.goalBias must be an object when set.");
      } else {
        for (const field of [
          "helperWeight",
          "earnerWeight",
          "reliabilityWeight",
          "selfWeight",
          "creativeJoyWeight"
        ]) {
          const value = goalBias[field];
          if (value !== void 0 && (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1)) {
            errors.push(`autonomy.goalBias.${field} must be a number in [0, 1] when set.`);
          }
        }
      }
    }
    if (isPlainObject(autonomy) && autonomy.creativeJoy !== void 0) {
      const cj = autonomy.creativeJoy;
      if (!isPlainObject(cj)) {
        errors.push("autonomy.creativeJoy must be an object when set.");
      } else {
        const rec = cj;
        if (rec.enabled !== void 0 && typeof rec.enabled !== "boolean") {
          errors.push("autonomy.creativeJoy.enabled must be a boolean when set.");
        }
        if (rec.maxPerDay !== void 0 && (typeof rec.maxPerDay !== "number" || !Number.isSafeInteger(rec.maxPerDay) || rec.maxPerDay < 0 || rec.maxPerDay > 48)) {
          errors.push("autonomy.creativeJoy.maxPerDay must be an integer from 0 through 48 when set.");
        }
        if (rec.minIdleMs !== void 0 && (typeof rec.minIdleMs !== "number" || !Number.isFinite(rec.minIdleMs) || rec.minIdleMs < 0)) {
          errors.push("autonomy.creativeJoy.minIdleMs must be a non-negative number when set.");
        }
        if (rec.allowWhenUserBusy !== void 0 && typeof rec.allowWhenUserBusy !== "boolean") {
          errors.push("autonomy.creativeJoy.allowWhenUserBusy must be a boolean when set.");
        }
        if (rec.localOnly !== void 0 && typeof rec.localOnly !== "boolean") {
          errors.push("autonomy.creativeJoy.localOnly must be a boolean when set.");
        }
        if (rec.outputDir !== void 0 && (typeof rec.outputDir !== "string" || rec.outputDir.trim().length === 0)) {
          errors.push("autonomy.creativeJoy.outputDir must be a non-empty string when set.");
        }
        const validHw = /* @__PURE__ */ new Set(["m4-16gb", "workstation-32gb", "workstation-64gb-plus", "auto"]);
        if (rec.hardwareProfile !== void 0 && (typeof rec.hardwareProfile !== "string" || !validHw.has(rec.hardwareProfile))) {
          errors.push(
            "autonomy.creativeJoy.hardwareProfile must be one of: m4-16gb, workstation-32gb, workstation-64gb-plus, auto."
          );
        }
      }
    }
    if (isPlainObject(autonomy) && autonomy.dailyAssistant !== void 0) {
      const da = autonomy.dailyAssistant;
      if (!isPlainObject(da)) {
        errors.push("autonomy.dailyAssistant must be an object when set.");
      } else {
        const rec = da;
        if (rec.prioritizeDuties !== void 0 && typeof rec.prioritizeDuties !== "boolean") {
          errors.push("autonomy.dailyAssistant.prioritizeDuties must be a boolean when set.");
        }
        for (const field of ["creatorRevenueWeight", "creativeJoyWeight"]) {
          const value = rec[field];
          if (value !== void 0 && (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1)) {
            errors.push(`autonomy.dailyAssistant.${field} must be a number in [0, 1] when set.`);
          }
        }
      }
    }
    if (isPlainObject(autonomy) && autonomy.hardwareProfile !== void 0) {
      const hp = autonomy.hardwareProfile;
      const validHw = /* @__PURE__ */ new Set(["m4-16gb", "workstation-32gb", "workstation-64gb-plus", "auto"]);
      if (typeof hp !== "string" || !validHw.has(hp)) {
        errors.push(
          "autonomy.hardwareProfile must be one of: m4-16gb, workstation-32gb, workstation-64gb-plus, auto."
        );
      }
    }
    if (isPlainObject(autonomy) && autonomy.partnership !== void 0) {
      const p = autonomy.partnership;
      if (!isPlainObject(p)) {
        errors.push("autonomy.partnership must be an object when set.");
      } else {
        for (const field of [
          "enabled",
          "injectIdentity",
          "injectPractice",
          "injectTrust",
          "injectBoard"
        ]) {
          const value = p[field];
          if (value !== void 0 && typeof value !== "boolean") {
            errors.push(`autonomy.partnership.${field} must be a boolean when set.`);
          }
        }
        if (p.dir !== void 0 && (typeof p.dir !== "string" || String(p.dir).trim().length === 0)) {
          errors.push("autonomy.partnership.dir must be a non-empty string when set.");
        }
      }
    }
    if (isPlainObject(autonomy) && autonomy.selfImprovementOnly !== void 0 && typeof autonomy.selfImprovementOnly !== "boolean") {
      errors.push("autonomy.selfImprovementOnly must be a boolean when set.");
    }
    if (isPlainObject(autonomy) && autonomy.sustainment !== void 0 && typeof autonomy.sustainment !== "boolean") {
      errors.push("autonomy.sustainment must be a boolean when set.");
    }
    if (isPlainObject(autonomy)) {
      const goalCompiler = autonomy.goalCompiler;
      if (goalCompiler !== void 0 && typeof goalCompiler !== "boolean") {
        errors.push("autonomy.goalCompiler must be a boolean when set.");
      } else if (goalCompiler === true && autonomy.sustainment !== true) {
        errors.push("autonomy.goalCompiler requires autonomy.sustainment to be true.");
      }
    }
    if (isPlainObject(autonomy) && autonomy.curriculumRouting !== void 0) {
      const cr = autonomy.curriculumRouting;
      if (!isPlainObject(cr)) {
        errors.push("autonomy.curriculumRouting must be an object when set.");
      } else {
        const crRecord = cr;
        if (crRecord.enabled !== void 0 && typeof crRecord.enabled !== "boolean") {
          errors.push("autonomy.curriculumRouting.enabled must be a boolean when set.");
        }
        if (crRecord.model !== void 0 && crRecord.model !== null && (typeof crRecord.model !== "string" || crRecord.model.trim().length === 0)) {
          errors.push("autonomy.curriculumRouting.model must be a non-empty string or null when set.");
        }
        if (crRecord.maxTasksPerDay !== void 0 && (typeof crRecord.maxTasksPerDay !== "number" || !Number.isSafeInteger(crRecord.maxTasksPerDay) || crRecord.maxTasksPerDay < 0)) {
          errors.push("autonomy.curriculumRouting.maxTasksPerDay must be a non-negative integer when set.");
        }
      }
    }
  }
  if (config.studio !== void 0) {
    const studio = config.studio;
    if (!isPlainObject(studio)) {
      errors.push("studio must be an object when set.");
    } else {
      const s = studio;
      if (s.enabled !== void 0 && typeof s.enabled !== "boolean") {
        errors.push("studio.enabled must be a boolean when set.");
      }
      if (s.exportDir !== void 0 && (typeof s.exportDir !== "string" || s.exportDir.trim().length === 0)) {
        errors.push("studio.exportDir must be a non-empty string when set.");
      }
      if (s.tracksDir !== void 0 && (typeof s.tracksDir !== "string" || s.tracksDir.trim().length === 0)) {
        errors.push("studio.tracksDir must be a non-empty string when set.");
      }
      if (s.maxRetries !== void 0 && (typeof s.maxRetries !== "number" || !Number.isSafeInteger(s.maxRetries) || s.maxRetries < 0 || s.maxRetries > 5)) {
        errors.push("studio.maxRetries must be an integer between 0 and 5 when set.");
      }
    }
  }
  if (config.behavior !== void 0) {
    const behavior = config.behavior;
    if (!isPlainObject(behavior)) {
      errors.push("behavior must be an object when set.");
    } else {
      const b = behavior;
      if (b.dispositionGovernor !== void 0 && typeof b.dispositionGovernor !== "boolean") {
        errors.push("behavior.dispositionGovernor must be a boolean when set.");
      }
    }
  }
  if (config.zaraacoder?.executor !== void 0) {
    const executor = config.zaraacoder.executor;
    if (executor.enabled !== void 0 && typeof executor.enabled !== "boolean") {
      errors.push("zaraacoder.executor.enabled must be a boolean when set.");
    }
    if (executor.model !== void 0 && (typeof executor.model !== "string" || executor.model.trim().length === 0)) {
      errors.push("zaraacoder.executor.model must be a non-empty string when set.");
    }
    if (executor.maxToolCalls !== void 0 && (!Number.isSafeInteger(executor.maxToolCalls) || executor.maxToolCalls < 1)) {
      errors.push("zaraacoder.executor.maxToolCalls must be a positive safe integer when set.");
    }
    if (executor.allowNetwork !== void 0 && typeof executor.allowNetwork !== "boolean") {
      errors.push("zaraacoder.executor.allowNetwork must be a boolean when set.");
    }
    if (executor.allowPackageInstall !== void 0 && typeof executor.allowPackageInstall !== "boolean") {
      errors.push("zaraacoder.executor.allowPackageInstall must be a boolean when set.");
    }
    if (executor.backend !== void 0 && executor.backend !== "codex" && executor.backend !== "zero" && executor.backend !== "configured") {
      errors.push('zaraacoder.executor.backend must be one of "codex", "zero", "configured" when set.');
    }
    if (executor.greenfieldOnly !== void 0 && typeof executor.greenfieldOnly !== "boolean") {
      errors.push("zaraacoder.executor.greenfieldOnly must be a boolean when set.");
    }
    if (executor.laneModels !== void 0) {
      if (typeof executor.laneModels !== "object" || executor.laneModels === null) {
        errors.push("zaraacoder.executor.laneModels must be an object when set.");
      } else {
        for (const lane of ["grok", "local", "claude", "codex"]) {
          const model = executor.laneModels[lane];
          if (model !== void 0 && (typeof model !== "string" || model.trim().length === 0)) {
            errors.push(
              `zaraacoder.executor.laneModels.${lane} must be a non-empty string when set.`
            );
          }
        }
      }
    }
    if (executor.subscriptionBudget !== void 0) {
      const budget = executor.subscriptionBudget;
      if (budget.enabled !== void 0 && typeof budget.enabled !== "boolean") {
        errors.push("zaraacoder.executor.subscriptionBudget.enabled must be a boolean when set.");
      }
      if (budget.maxTasksPerDay !== void 0 && budget.maxTasksPerDay !== null && (!Number.isSafeInteger(budget.maxTasksPerDay) || budget.maxTasksPerDay < 1)) {
        errors.push(
          "zaraacoder.executor.subscriptionBudget.maxTasksPerDay must be a positive safe integer or null when set."
        );
      }
      if (budget.maxUsdPerDay !== void 0 && budget.maxUsdPerDay !== null && (typeof budget.maxUsdPerDay !== "number" || !Number.isFinite(budget.maxUsdPerDay) || budget.maxUsdPerDay <= 0)) {
        errors.push(
          "zaraacoder.executor.subscriptionBudget.maxUsdPerDay must be a positive number or null when set."
        );
      }
    }
  }
  if (config.gateway?.auth !== void 0) {
    const auth = config.gateway.auth;
    if (auth.apiKey !== void 0 && (typeof auth.apiKey !== "string" || auth.apiKey.length === 0)) {
      errors.push("gateway.auth.apiKey must be a non-empty string");
    }
  }
  if (config.gateway?.publicUrl !== void 0) {
    const publicUrl = config.gateway.publicUrl;
    if (typeof publicUrl !== "string" || publicUrl.length === 0) {
      errors.push("gateway.publicUrl must be a non-empty string when set");
    } else if (!/^https?:\/\//i.test(publicUrl)) {
      errors.push("gateway.publicUrl must start with http:// or https://");
    }
  }
  if (config.gateway?.webhooks?.dispatchSecret !== void 0) {
    const dispatchSecret = config.gateway.webhooks.dispatchSecret;
    if (typeof dispatchSecret !== "string" || dispatchSecret.length === 0) {
      errors.push("gateway.webhooks.dispatchSecret must be a non-empty string when set");
    }
  }
  if (config.gateway?.webhooks?.replayStorePath !== void 0) {
    const replayStorePath = config.gateway.webhooks.replayStorePath;
    if (typeof replayStorePath !== "string" || replayStorePath.length === 0) {
      errors.push("gateway.webhooks.replayStorePath must be a non-empty string when set");
    }
  }
  if (config.security !== void 0) {
    if (typeof config.security !== "object" || config.security === null || Array.isArray(config.security)) {
      errors.push("security must be an object when set.");
    } else {
      if (config.security.researchDomainAllowlist !== void 0) {
        const allowlist = config.security.researchDomainAllowlist;
        if (!Array.isArray(allowlist)) {
          errors.push("security.researchDomainAllowlist must be an array of non-empty strings when set.");
        } else if (allowlist.some((domain) => typeof domain !== "string" || domain.length === 0)) {
          errors.push("security.researchDomainAllowlist entries must be non-empty strings.");
        }
      }
      if (config.security.declaredWorkRoots !== void 0) {
        const roots = config.security.declaredWorkRoots;
        if (!Array.isArray(roots)) {
          errors.push("security.declaredWorkRoots must be an array of absolute paths when set.");
        } else if (roots.some((root) => typeof root !== "string" || root.length === 0)) {
          errors.push("security.declaredWorkRoots entries must be non-empty strings.");
        } else if (roots.some((root) => !root.startsWith("/"))) {
          errors.push("security.declaredWorkRoots entries must be absolute paths.");
        }
      }
    }
  }
  if (config.notifications?.webhook !== void 0) {
    const webhook = config.notifications.webhook;
    if (webhook.url !== void 0) {
      if (!webhook.url.startsWith("http://") && !webhook.url.startsWith("https://")) {
        errors.push("webhook url must start with http:// or https://");
      }
    }
  }
  if (config.notifications?.healthchecksUrl !== void 0) {
    const url = config.notifications.healthchecksUrl;
    if (typeof url !== "string" || url.length === 0) {
      errors.push("notifications.healthchecksUrl must be a non-empty string when set");
    } else if (!/^https?:\/\//i.test(url)) {
      errors.push("notifications.healthchecksUrl must start with http:// or https://");
    }
  }
  if (config.notifications?.healthchecksIntervalMs !== void 0) {
    const ms = config.notifications.healthchecksIntervalMs;
    if (typeof ms !== "number" || Number.isNaN(ms) || ms < 1e4) {
      errors.push("notifications.healthchecksIntervalMs must be a number \u2265 10000 ms");
    }
  }
  if (config.notifications?.ntfyTopicUrl !== void 0) {
    const url = config.notifications.ntfyTopicUrl;
    if (typeof url !== "string" || url.length === 0) {
      errors.push("notifications.ntfyTopicUrl must be a non-empty string when set");
    } else if (!/^https?:\/\//i.test(url)) {
      errors.push("notifications.ntfyTopicUrl must start with http:// or https://");
    }
  }
  if (config.notifications?.completion !== void 0) {
    const completion = config.notifications.completion;
    const validChannels = ["os", "websocket", "webhook", "console", "imessage", "ntfy"];
    const validNotifyOn = ["completed", "backgrounded", "manual_review"];
    if (completion.enabled !== void 0 && typeof completion.enabled !== "boolean") {
      errors.push("notifications.completion.enabled must be a boolean when set.");
    }
    if (completion.optInOnly !== void 0 && typeof completion.optInOnly !== "boolean") {
      errors.push("notifications.completion.optInOnly must be a boolean when set.");
    }
    if (completion.longTaskMinMs !== void 0 && (typeof completion.longTaskMinMs !== "number" || completion.longTaskMinMs < 0)) {
      errors.push("notifications.completion.longTaskMinMs must be a non-negative number when set.");
    }
    if (completion.throttleMs !== void 0 && (typeof completion.throttleMs !== "number" || completion.throttleMs < 0)) {
      errors.push("notifications.completion.throttleMs must be a non-negative number when set.");
    }
    if (completion.channels !== void 0) {
      if (!Array.isArray(completion.channels) || completion.channels.some((channel) => typeof channel !== "string" || !validChannels.includes(channel))) {
        errors.push(`notifications.completion.channels must be an array containing only: ${validChannels.join(", ")}.`);
      }
    }
    if (completion.notifyOn !== void 0) {
      if (!Array.isArray(completion.notifyOn) || completion.notifyOn.some((state) => typeof state !== "string" || !validNotifyOn.includes(state))) {
        errors.push(`notifications.completion.notifyOn must be an array containing only: ${validNotifyOn.join(", ")}.`);
      }
    }
  }
  if (config.monitoring?.alerts !== void 0) {
    const alerts = config.monitoring.alerts;
    if (alerts.enabled !== void 0 && typeof alerts.enabled !== "boolean") {
      errors.push("monitoring.alerts.enabled must be a boolean when set.");
    }
    if (alerts.maxPerHour !== void 0) {
      if (typeof alerts.maxPerHour !== "number" || alerts.maxPerHour < 0 || !Number.isFinite(alerts.maxPerHour)) {
        errors.push("monitoring.alerts.maxPerHour must be a finite non-negative number when set.");
      }
    }
    if (alerts.maxPerDay !== void 0) {
      if (typeof alerts.maxPerDay !== "number" || alerts.maxPerDay < 0 || !Number.isFinite(alerts.maxPerDay)) {
        errors.push("monitoring.alerts.maxPerDay must be a finite non-negative number when set.");
      }
    }
    for (const key of ["quietHoursStart", "quietHoursEnd"]) {
      if (alerts[key] !== void 0) {
        const v = alerts[key];
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 23) {
          errors.push(`monitoring.alerts.${key} must be an integer 0-23 when set.`);
        }
      }
    }
    if (alerts.timeZone !== void 0 && (typeof alerts.timeZone !== "string" || alerts.timeZone.length === 0)) {
      errors.push("monitoring.alerts.timeZone must be a non-empty string when set.");
    }
    if (alerts.dedupWindowMs !== void 0) {
      if (typeof alerts.dedupWindowMs !== "number" || alerts.dedupWindowMs < 0 || !Number.isFinite(alerts.dedupWindowMs)) {
        errors.push("monitoring.alerts.dedupWindowMs must be a finite non-negative number when set.");
      }
    }
    if (alerts.historySize !== void 0) {
      if (typeof alerts.historySize !== "number" || !Number.isInteger(alerts.historySize) || alerts.historySize < 1) {
        errors.push("monitoring.alerts.historySize must be a positive integer when set.");
      }
    }
    if (alerts.skipLowSeverity !== void 0 && typeof alerts.skipLowSeverity !== "boolean") {
      errors.push("monitoring.alerts.skipLowSeverity must be a boolean when set.");
    }
  }
  const validProviderTypes = ["anthropic", "openai", "ollama", "openrouter", "openai-compatible", "xai", "gemini", "claude-cli", "codex", "cursor", "cursor-agent", "cursor-sdk", "custom"];
  if (config.providers) {
    for (const [providerIndex, provider] of config.providers.entries()) {
      if (provider.type && !validProviderTypes.includes(provider.type)) {
        errors.push(
          `Invalid provider type "${provider.type}". Must be one of: ${validProviderTypes.join(", ")}`
        );
      }
      if (provider.type === "anthropic" || provider.type === "openai" || provider.type === "openrouter" || provider.type === "openai-compatible" || provider.type === "custom" || provider.type === "cursor-sdk") {
        const hasCredentials = provider.apiKey || provider.auth === "oauth" || provider.auth === "keychain" || provider.auth === "env" || provider.envVar;
        if (!hasCredentials) {
          warnings.push(
            `Provider "${provider.name || provider.type}" has no credentials configured (apiKey, auth, or envVar). It will fail at runtime.`
          );
        }
      }
      if (provider.cliTimeouts !== void 0) {
        const cliTimeouts = provider.cliTimeouts;
        if (typeof cliTimeouts !== "object" || cliTimeouts === null || Array.isArray(cliTimeouts)) {
          errors.push(`providers[${providerIndex}].cliTimeouts must be an object when set.`);
        } else {
          for (const key of ["spawnMs", "streamMs", "overallMs"]) {
            const value = cliTimeouts[key];
            if (value !== void 0 && (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
              errors.push(`providers[${providerIndex}].cliTimeouts.${key} must be a positive integer when set.`);
            }
          }
        }
      }
      if (provider.type === "anthropic" && provider.apiKey && typeof provider.apiKey === "string" && !provider.apiKey.startsWith("sk-ant-")) {
        warnings.push(
          `ANTHROPIC_API_KEY for provider "${provider.name || "anthropic"}" must start with 'sk-ant-'. The value looks incorrect \u2014 authentication will fail at runtime.`
        );
      }
      if (provider.type === "openai" && provider.apiKey && typeof provider.apiKey === "string" && !provider.apiKey.startsWith("sk-")) {
        warnings.push(
          `API key for OpenAI provider "${provider.name || "openai"}" must start with 'sk-'. The value looks incorrect \u2014 authentication will fail at runtime.`
        );
      }
      if (provider.type === "cursor-sdk") {
        if (provider.apiKey && typeof provider.apiKey === "string" && provider.apiKey.trim()) {
          errors.push(
            `Provider "${provider.name || "cursor-sdk"}" must not store CURSOR_API_KEY in zaraa.config.json. Use auth "env" with envVar "${provider.envVar ?? "CURSOR_API_KEY"}" or auth "keychain".`
          );
        }
        const auth = provider.auth;
        if (auth === "config" || auth === "api-key" || auth === "api_key" || auth === "apiKey") {
          errors.push(
            `Provider "${provider.name || "cursor-sdk"}" cannot use auth "${auth}" for Cursor credentials. Use auth "env" or auth "keychain".`
          );
        }
        if (!provider.apiKey && provider.auth !== "keychain" && provider.auth !== "env" && provider.auth !== void 0 && provider.auth !== "none") {
          warnings.push(
            `Provider "${provider.name || "cursor-sdk"}" should use auth "env" (CURSOR_API_KEY) or auth "keychain" \u2014 not "${provider.auth}".`
          );
        }
      }
      if (provider.name !== void 0 && (typeof provider.name !== "string" || provider.name.trim() === "")) {
        errors.push(`A provider has an empty or invalid name. Each provider must have a non-empty "name" field.`);
      }
      if (provider.aliases !== void 0) {
        if (!Array.isArray(provider.aliases) || provider.aliases.some((alias) => typeof alias !== "string" || alias.trim() === "")) {
          errors.push(`Provider "${provider.name || provider.type}" aliases must be a non-empty string array when set.`);
        }
      }
      if (provider.modelAliases !== void 0) {
        if (typeof provider.modelAliases !== "object" || provider.modelAliases === null || Array.isArray(provider.modelAliases)) {
          errors.push(`Provider "${provider.name || provider.type}" modelAliases must be an object map of model -> string[].`);
        } else {
          for (const [modelName, aliases] of Object.entries(provider.modelAliases)) {
            if (typeof modelName !== "string" || modelName.trim() === "") {
              errors.push(`Provider "${provider.name || provider.type}" has an invalid modelAliases key.`);
              continue;
            }
            if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string" || alias.trim() === "")) {
              errors.push(`Provider "${provider.name || provider.type}" modelAliases.${modelName} must be a non-empty string array.`);
            }
          }
        }
      }
    }
  }
  if (config.models?.default !== void 0 && (typeof config.models.default !== "string" || config.models.default.trim() === "")) {
    errors.push(`models.default must be a non-empty string (e.g. "claude-sonnet-5").`);
  }
  if (config.models?.default && config.providers?.length) {
    const defaultModel = config.models.default;
    const configuredRouteAliases = Object.keys(config.models.aliases ?? {});
    const configuredModels = config.providers.flatMap((provider) => (provider.models ?? []).flatMap((model) => {
      const aliases = [model];
      if (provider.name) aliases.push(`${provider.name}:${model}`);
      for (const providerAlias of provider.aliases ?? []) {
        aliases.push(`${providerAlias}:${model}`);
      }
      for (const modelAlias of provider.modelAliases?.[model] ?? []) {
        aliases.push(modelAlias);
      }
      return aliases;
    })).concat(configuredRouteAliases).filter((model) => typeof model === "string" && model.trim() !== "");
    const hasMatchingProvider = configuredModels.includes(defaultModel);
    if (!hasMatchingProvider) {
      warnings.push(
        `models.default "${defaultModel}" does not match any configured provider model (${configuredModels.join(", ")}). Verify the model name maps to a provider \u2014 runtime routing may fail.`
      );
    }
  }
  if (config.models?.aliases !== void 0) {
    const aliases = config.models.aliases;
    if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) {
      errors.push("models.aliases must be an object map of alias -> model.");
    } else {
      for (const [alias, target] of Object.entries(aliases)) {
        if (typeof alias !== "string" || alias.trim() === "" || typeof target !== "string" || target.trim() === "") {
          errors.push("models.aliases entries must be non-empty string -> non-empty string mappings.");
        }
      }
    }
  }
  if (config.scheduler?.limits !== void 0) {
    const { limits } = config.scheduler;
    if (limits.maxCostPerDay !== void 0 && limits.maxCostPerDay !== "") {
      const stripped = limits.maxCostPerDay.replace(/^\$/, "");
      const parsed = parseFloat(stripped);
      if (Number.isNaN(parsed) || parsed < 0) {
        errors.push(
          `scheduler.limits.maxCostPerDay must be a non-negative number string (e.g. "10.00"). Got: "${limits.maxCostPerDay}".`
        );
      }
    }
    if (limits.maxTasksPerHour !== void 0 && limits.maxTasksPerHour === 0) {
      warnings.push(
        `scheduler.limits.maxTasksPerHour is 0, which means unlimited tasks per hour. If this is intentional, you can ignore this warning.`
      );
    }
  }
  const quietHours = config.notifications?.quietHours;
  if (quietHours !== void 0) {
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (quietHours.start !== void 0 && !timeRe.test(quietHours.start)) {
      errors.push(
        `notifications.quietHours.start must be in "HH:MM" format (e.g. "22:00"). Got: "${quietHours.start}".`
      );
    }
    if (quietHours.end !== void 0 && !timeRe.test(quietHours.end)) {
      errors.push(
        `notifications.quietHours.end must be in "HH:MM" format (e.g. "07:00"). Got: "${quietHours.end}".`
      );
    }
  }
  if (config.voice !== void 0) {
    const validVoiceProviders = ["openai-realtime", "openai-realtime-hybrid", "pipeline"];
    if (!validVoiceProviders.includes(config.voice.provider)) {
      errors.push(
        `Invalid voice.provider "${config.voice.provider}". Must be one of: ${validVoiceProviders.join(", ")}.`
      );
    }
    if (config.voice.tts !== void 0) {
      const validTtsEngines = [
        "openai-tts",
        "macos-say",
        "piper",
        "elevenlabs",
        "voxtral",
        "voxtral-local",
        "mlx-audio-local",
        "xai-tts"
      ];
      if (config.voice.tts.engine && !validTtsEngines.includes(config.voice.tts.engine)) {
        errors.push(
          `Invalid voice.tts.engine "${config.voice.tts.engine}". Must be one of: ${validTtsEngines.join(", ")}.`
        );
      }
    }
    if (config.voice.stt !== void 0) {
      const validSttEngines = ["whisper", "vosk", "deepgram", "xai-stt"];
      if (config.voice.stt.engine && !validSttEngines.includes(config.voice.stt.engine)) {
        errors.push(
          `Invalid voice.stt.engine "${config.voice.stt.engine}". Must be one of: ${validSttEngines.join(", ")}.`
        );
      }
    }
  }
  const pluginsConfig = config.plugins;
  if (pluginsConfig?.dir !== void 0 && typeof pluginsConfig.dir !== "string") {
    errors.push(`plugins.dir must be a string path. Got: ${JSON.stringify(pluginsConfig.dir)}.`);
  }
  const trading = config.trading;
  if (trading !== void 0) {
    if (typeof trading !== "object" || trading === null || Array.isArray(trading)) {
      errors.push("trading must be an object when set.");
    } else {
      const t = trading;
      const stringFields = ["apiKey", "apiSecret", "solanaRpcUrl", "solanaDexSecretKey", "liveModeLock"];
      for (const key of stringFields) {
        const v = t[key];
        if (v === void 0) continue;
        if (typeof v !== "string") {
          errors.push(`trading.${key} must be a string when set.`);
        } else if (v.trim() === "" && key !== "apiKey" && key !== "apiSecret") {
          errors.push(`trading.${key} must be a non-empty string when set.`);
        }
      }
      for (const key of ["paperMode", "autoExecuteLive"]) {
        const v = t[key];
        if (v === void 0) continue;
        if (typeof v !== "boolean" && typeof v !== "string") {
          errors.push(`trading.${key} must be a boolean or string when set.`);
        }
      }
      if (isExplicitLivePaperMode(t.paperMode)) {
        const expectedLock = expectedLiveModeLock();
        const liveModeLock = t.liveModeLock;
        if (typeof liveModeLock !== "string" || liveModeLock.trim() === "") {
          errors.push(
            `trading.liveModeLock is required when trading.paperMode is false. Expected "${expectedLock}".`
          );
        } else if (liveModeLock !== expectedLock) {
          errors.push(
            `trading.liveModeLock must match today's UTC confirmation lock "${expectedLock}" when trading.paperMode is false.`
          );
        }
      }
      if (typeof t.solanaRpcUrl === "string" && t.solanaRpcUrl.trim() !== "") {
        if (!URL.canParse(t.solanaRpcUrl)) {
          errors.push(
            `trading.solanaRpcUrl must be a valid URL (e.g. https://api.mainnet-beta.solana.com). Got: "${t.solanaRpcUrl}".`
          );
        }
      }
      if (typeof t.solanaDexSecretKey === "string" && t.solanaDexSecretKey.length > 0) {
        warnings.push(
          "trading.solanaDexSecretKey is set in the config file. Prefer the SOLANA_DEX_SECRET_KEY environment variable in production."
        );
      }
      const sessionGates = t.sessionGates;
      if (sessionGates !== void 0) {
        if (!isPlainObject(sessionGates)) {
          errors.push("trading.sessionGates must be an object when set.");
        } else {
          for (const session of ["asian", "european", "us", "off_hours"]) {
            const gate = sessionGates[session];
            if (gate === void 0) continue;
            if (!isPlainObject(gate)) {
              errors.push(`trading.sessionGates.${session} must be an object when set.`);
              continue;
            }
            const minConf = gate.minConfidence;
            if (minConf !== void 0 && (typeof minConf !== "number" || minConf < 0 || minConf > 1)) {
              errors.push(`trading.sessionGates.${session}.minConfidence must be a number between 0 and 1.`);
            }
            const enabled = gate.enabled;
            if (enabled !== void 0 && typeof enabled !== "boolean") {
              errors.push(`trading.sessionGates.${session}.enabled must be a boolean when set.`);
            }
          }
        }
      }
      const symbolGate = t.symbolGate;
      if (symbolGate !== void 0) {
        if (!isPlainObject(symbolGate)) {
          errors.push("trading.symbolGate must be an object when set.");
        } else {
          const sg = symbolGate;
          if (sg.enabled !== void 0 && typeof sg.enabled !== "boolean") {
            errors.push("trading.symbolGate.enabled must be a boolean when set.");
          }
          for (const key of ["rollingWindow", "minTrades"]) {
            const v = sg[key];
            if (v !== void 0 && (typeof v !== "number" || !Number.isInteger(v) || v < 1)) {
              errors.push(`trading.symbolGate.${key} must be a positive integer when set.`);
            }
          }
          if (sg.minWinRate !== void 0 && (typeof sg.minWinRate !== "number" || sg.minWinRate < 0 || sg.minWinRate > 1)) {
            errors.push("trading.symbolGate.minWinRate must be a number between 0 and 1.");
          }
        }
      }
      const correlationGuard = t.correlationGuard;
      if (correlationGuard !== void 0) {
        if (!isPlainObject(correlationGuard)) {
          errors.push("trading.correlationGuard must be an object when set.");
        } else {
          const cg = correlationGuard;
          if (cg.enabled !== void 0 && typeof cg.enabled !== "boolean") {
            errors.push("trading.correlationGuard.enabled must be a boolean when set.");
          }
          for (const key of ["correlationThreshold", "correlationScaleThreshold"]) {
            const v = cg[key];
            if (v !== void 0 && (typeof v !== "number" || v < 0 || v > 1)) {
              errors.push(`trading.correlationGuard.${key} must be a number between 0 and 1.`);
            }
          }
          if (cg.maxCorrelatedExposureMultiplier !== void 0 && (typeof cg.maxCorrelatedExposureMultiplier !== "number" || cg.maxCorrelatedExposureMultiplier < 1)) {
            errors.push("trading.correlationGuard.maxCorrelatedExposureMultiplier must be a number \u2265 1 when set.");
          }
          if (cg.minDataPoints !== void 0 && (typeof cg.minDataPoints !== "number" || !Number.isInteger(cg.minDataPoints) || cg.minDataPoints < 2)) {
            errors.push("trading.correlationGuard.minDataPoints must be an integer \u2265 2 when set.");
          }
          if (cg.staticCorrelations !== void 0) {
            if (!Array.isArray(cg.staticCorrelations)) {
              errors.push("trading.correlationGuard.staticCorrelations must be an array when set.");
            } else {
              for (const [i, pair] of cg.staticCorrelations.entries()) {
                if (!Array.isArray(pair) || pair.length !== 3 || typeof pair[0] !== "string" || typeof pair[1] !== "string" || typeof pair[2] !== "number" || pair[2] < -1 || pair[2] > 1) {
                  errors.push(`trading.correlationGuard.staticCorrelations[${i}] must be [string, string, number \u2208 [-1,1]].`);
                }
              }
            }
          }
        }
      }
      const regimeThresholds = t.regimeThresholds;
      if (regimeThresholds !== void 0) {
        if (!isPlainObject(regimeThresholds)) {
          errors.push("trading.regimeThresholds must be an object when set.");
        } else {
          const rt = regimeThresholds;
          for (const key of ["adxTrendMin", "adxRangeMax"]) {
            const v = rt[key];
            if (v !== void 0 && (typeof v !== "number" || v < 0 || v > 100)) {
              errors.push(`trading.regimeThresholds.${key} must be a number between 0 and 100.`);
            }
          }
          if (rt.patternConfidenceMin !== void 0 && (typeof rt.patternConfidenceMin !== "number" || rt.patternConfidenceMin < 0 || rt.patternConfidenceMin > 1)) {
            errors.push("trading.regimeThresholds.patternConfidenceMin must be a number between 0 and 1.");
          }
        }
      }
    }
  }
  const predictions = config.predictions;
  if (predictions !== void 0) {
    if (typeof predictions !== "object" || predictions === null || Array.isArray(predictions)) {
      errors.push("predictions must be an object when set.");
    } else {
      const p = predictions;
      for (const key of ["paperMode", "autoExecuteLive"]) {
        const v = p[key];
        if (v === void 0) continue;
        if (typeof v !== "boolean" && typeof v !== "string") {
          errors.push(`predictions.${key} must be a boolean or string when set.`);
        }
      }
      const polymarket = p.polymarket;
      if (polymarket !== void 0) {
        if (typeof polymarket !== "object" || polymarket === null || Array.isArray(polymarket)) {
          errors.push("predictions.polymarket must be an object when set.");
        } else {
          const venue = polymarket;
          const stringFields = [
            "gammaBaseUrl",
            "clobBaseUrl",
            "apiKey",
            "apiSecret",
            "apiPassphrase",
            "privateKey",
            "funder"
          ];
          for (const key of stringFields) {
            const v = venue[key];
            if (v === void 0) continue;
            if (typeof v !== "string") {
              errors.push(`predictions.polymarket.${key} must be a string when set.`);
            } else if (v.trim() === "") {
              errors.push(`predictions.polymarket.${key} must be a non-empty string when set.`);
            }
          }
          const numberFields = [
            "pageSize",
            "maxMarkets",
            "maxConcurrentBookFetches",
            "timeoutMs"
          ];
          for (const key of numberFields) {
            const v = venue[key];
            if (v === void 0) continue;
            if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) {
              errors.push(`predictions.polymarket.${key} must be a positive integer when set.`);
            }
          }
          for (const key of ["maxLiveOrderSize", "maxLiveOrderNotionalUsd"]) {
            const v = venue[key];
            if (v === void 0) continue;
            if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
              errors.push(`predictions.polymarket.${key} must be a positive finite number when set.`);
            }
          }
          for (const key of ["fetchOrderBooks", "useServerTime"]) {
            const v = venue[key];
            if (v === void 0) continue;
            if (typeof v !== "boolean") {
              errors.push(`predictions.polymarket.${key} must be a boolean when set.`);
            }
          }
          for (const key of ["gammaBaseUrl", "clobBaseUrl"]) {
            const raw = venue[key];
            if (typeof raw === "string" && raw.trim() !== "" && !URL.canParse(raw)) {
              errors.push(`predictions.polymarket.${key} must be a valid URL. Got: "${raw}".`);
            }
          }
          if (venue.signatureType !== void 0 && (typeof venue.signatureType !== "number" || !VALID_POLYMARKET_SIGNATURE_TYPES.includes(venue.signatureType))) {
            errors.push(
              `predictions.polymarket.signatureType must be one of: ${VALID_POLYMARKET_SIGNATURE_TYPES.join(", ")}.`
            );
          }
          if (venue.chainId !== void 0 && (typeof venue.chainId !== "number" || !VALID_POLYMARKET_CHAIN_IDS.includes(venue.chainId))) {
            errors.push(
              `predictions.polymarket.chainId must be one of: ${VALID_POLYMARKET_CHAIN_IDS.join(", ")}.`
            );
          }
          const hasAnyApiCred = Boolean(venue.apiKey || venue.apiSecret || venue.apiPassphrase);
          const hasAllApiCreds = Boolean(venue.apiKey && venue.apiSecret && venue.apiPassphrase);
          if (hasAnyApiCred && !hasAllApiCreds) {
            errors.push(
              "predictions.polymarket.apiKey, apiSecret, and apiPassphrase must all be provided together when supplying cached CLOB credentials."
            );
          }
          if ((venue.signatureType === 1 || venue.signatureType === 2) && !venue.funder) {
            errors.push("predictions.polymarket.funder is required when signatureType is 1 or 2.");
          }
        }
      }
    }
  }
  const gui = config.gui;
  if (gui !== void 0) {
    if (typeof gui !== "object" || gui === null || Array.isArray(gui)) {
      errors.push("gui must be an object when set.");
    } else {
      const g = gui;
      if (g.enabled !== void 0 && typeof g.enabled !== "boolean") {
        errors.push("gui.enabled must be a boolean when set.");
      }
      if (g.helperBinPath !== void 0 && typeof g.helperBinPath !== "string") {
        errors.push("gui.helperBinPath must be a string path when set.");
      }
      if (g.vlm !== void 0) {
        if (!isPlainObject(g.vlm)) {
          errors.push("gui.vlm must be an object when set.");
        } else {
          const vlm = g.vlm;
          if (vlm.provider !== void 0 && vlm.provider !== "ollama") {
            errors.push('gui.vlm.provider must be "ollama" when set.');
          }
          if (vlm.model !== void 0 && typeof vlm.model !== "string") {
            errors.push("gui.vlm.model must be a string when set.");
          }
          if (vlm.host !== void 0) {
            if (typeof vlm.host !== "string") {
              errors.push("gui.vlm.host must be a string URL when set.");
            } else if (!URL.canParse(vlm.host)) {
              errors.push(
                `gui.vlm.host must be a valid URL (e.g. http://127.0.0.1:11434). Got: "${vlm.host}".`
              );
            }
          }
        }
      }
      if (g.safety !== void 0) {
        if (!isPlainObject(g.safety)) {
          errors.push("gui.safety must be an object when set.");
        } else {
          const s = g.safety;
          if (s.actionsPerMinute !== void 0) {
            if (typeof s.actionsPerMinute !== "number" || !Number.isInteger(s.actionsPerMinute) || s.actionsPerMinute < 0) {
              errors.push("gui.safety.actionsPerMinute must be a non-negative integer when set.");
            }
          }
          if (s.screenshotsPerMinute !== void 0) {
            if (typeof s.screenshotsPerMinute !== "number" || !Number.isInteger(s.screenshotsPerMinute) || s.screenshotsPerMinute < 0) {
              errors.push("gui.safety.screenshotsPerMinute must be a non-negative integer when set.");
            }
          }
          if (s.sensitiveApps !== void 0) {
            if (!Array.isArray(s.sensitiveApps) || s.sensitiveApps.some((x) => typeof x !== "string")) {
              errors.push("gui.safety.sensitiveApps must be an array of strings when set.");
            }
          }
          if (s.remoteProvidersAllowedInZone !== void 0) {
            const validZones = /* @__PURE__ */ new Set(["trusted", "guarded", "sandbox"]);
            if (!Array.isArray(s.remoteProvidersAllowedInZone) || s.remoteProvidersAllowedInZone.some((z) => typeof z !== "string" || !validZones.has(z))) {
              errors.push('gui.safety.remoteProvidersAllowedInZone must be an array of "sandbox"|"guarded"|"trusted".');
            }
          }
        }
      }
    }
  }
  const video = config.video;
  if (video !== void 0) {
    if (typeof video !== "object" || video === null || Array.isArray(video)) {
      errors.push("video must be an object when set.");
    } else {
      const v = video;
      if (v.enabled !== void 0 && typeof v.enabled !== "boolean") {
        errors.push("video.enabled must be a boolean when set.");
      }
      if (v.frameBudget !== void 0 && typeof v.frameBudget !== "number") {
        errors.push("video.frameBudget must be a number when set.");
      }
      if (v.resolution !== void 0 && typeof v.resolution !== "number") {
        errors.push("video.resolution must be a number when set.");
      }
      if (v.vlm !== void 0 && !isPlainObject(v.vlm)) {
        errors.push("video.vlm must be an object when set.");
      }
      if (v.stt !== void 0 && !isPlainObject(v.stt)) {
        errors.push("video.stt must be an object when set.");
      }
    }
  }
  const continuity = config.continuity;
  if (continuity !== void 0) {
    if (!isPlainObject(continuity)) {
      errors.push("continuity must be an object when set.");
    } else if (continuity.enabled !== void 0 && typeof continuity.enabled !== "boolean") {
      errors.push("continuity.enabled must be a boolean when set.");
    }
  }
  if (config.mcp !== void 0) {
    const mcp = config.mcp;
    if (mcp.enabled !== void 0 && typeof mcp.enabled !== "boolean") {
      errors.push("mcp.enabled must be a boolean when set.");
    }
    if (mcp.servers !== void 0 && !Array.isArray(mcp.servers)) {
      errors.push("mcp.servers must be an array when set.");
    } else if (Array.isArray(mcp.servers)) {
      const validTransports = /* @__PURE__ */ new Set(["stdio", "http", "sse"]);
      const seenNames = /* @__PURE__ */ new Set();
      mcp.servers.forEach((raw, i) => {
        if (!isPlainObject(raw)) {
          errors.push(`mcp.servers[${i}] must be an object.`);
          return;
        }
        const s = raw;
        const label = typeof s.name === "string" && s.name ? `"${s.name}"` : `[${i}]`;
        if (typeof s.name !== "string" || !s.name.trim()) {
          errors.push(`mcp.servers[${i}].name must be a non-empty string.`);
        } else if (seenNames.has(s.name)) {
          errors.push(`mcp.servers: duplicate server name "${s.name}".`);
        } else {
          seenNames.add(s.name);
        }
        if (typeof s.transport !== "string" || !validTransports.has(s.transport)) {
          warnings.push(
            `mcp.servers${label}: unknown transport "${String(s.transport)}". Expected one of: stdio, http, sse.`
          );
        }
        const hasCommand = typeof s.command === "string" && s.command.trim().length > 0;
        const hasUrl = typeof s.url === "string" && s.url.trim().length > 0;
        if (!hasCommand && !hasUrl) {
          warnings.push(
            `mcp.servers${label}: missing both "command" (stdio) and "url" (http/sse) \u2014 server cannot be reached and will be skipped.`
          );
        }
        if (s.transport === "stdio" && !hasCommand) {
          warnings.push(`mcp.servers${label}: stdio transport requires "command".`);
        }
        if ((s.transport === "http" || s.transport === "sse") && !hasUrl) {
          warnings.push(`mcp.servers${label}: ${s.transport} transport requires "url".`);
        }
        if (hasUrl) {
          let parsedUrl = null;
          try {
            parsedUrl = new URL(s.url);
          } catch {
            errors.push(`mcp.servers${label}.url "${String(s.url)}" is not a valid URL.`);
          }
          if (parsedUrl && parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            errors.push(
              `mcp.servers${label}.url must use http:// or https:// (got "${parsedUrl.protocol}").`
            );
          }
        }
        if (s.minZone !== void 0 && !VALID_ZONES.includes(s.minZone)) {
          errors.push(
            `mcp.servers${label}.minZone "${String(s.minZone)}" is invalid. Must be one of: ${VALID_ZONES.join(", ")}.`
          );
        }
        if (s.requiresApproval !== void 0 && typeof s.requiresApproval !== "boolean") {
          errors.push(`mcp.servers${label}.requiresApproval must be a boolean when set.`);
        }
        if (s.enabled !== void 0 && typeof s.enabled !== "boolean") {
          errors.push(`mcp.servers${label}.enabled must be a boolean when set.`);
        }
        if (s.args !== void 0 && (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string"))) {
          errors.push(`mcp.servers${label}.args must be an array of strings when set.`);
        }
      });
    }
  }
  return { warnings, errors };
}

// src/config/loader.ts
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = result[key];
    if (isPlainObject2(sourceVal) && isPlainObject2(targetVal)) {
      result[key] = deepMerge(
        targetVal,
        sourceVal
      );
    } else if (sourceVal !== void 0) {
      result[key] = sourceVal;
    }
  }
  return result;
}
function ensureDailyCryptoDisciplineTask(config) {
  const daily = DEFAULT_CONFIG.scheduler.tasks.find((t) => t.id === "daily-crypto-discipline");
  if (!daily) return config;
  if (config.scheduler.tasks.some((t) => t.id === "daily-crypto-discipline")) return config;
  return {
    ...config,
    scheduler: {
      ...config.scheduler,
      tasks: [...config.scheduler.tasks, { ...daily }]
    }
  };
}
function ensureCreativeJoyIdleTask(config) {
  const joy = DEFAULT_CONFIG.scheduler.tasks.find((t) => t.id === "creative-joy-idle");
  if (!joy) return config;
  if (config.scheduler.tasks.some((t) => t.id === "creative-joy-idle")) return config;
  if (config.autonomy?.creativeJoy?.enabled === false) return config;
  return {
    ...config,
    scheduler: {
      ...config.scheduler,
      tasks: [...config.scheduler.tasks, { ...joy }]
    }
  };
}
function commandCycleCron(localTime) {
  const [hour = "8", minute = "30"] = localTime.split(":");
  return `${Number.parseInt(minute, 10)} ${Number.parseInt(hour, 10)} * * 1-5`;
}
function ensureCommandCycleScheduleTasks(config) {
  const enabled = config.autonomy?.commandCycle?.enabled === true;
  const specs = [
    {
      id: "morning-command-cycle",
      phase: "morning",
      schedule: commandCycleCron(config.autonomy?.commandCycle?.morningLocalTime ?? "08:30"),
      prompt: "Run the morning command cycle report."
    },
    {
      id: "evening-command-cycle",
      phase: "evening",
      schedule: commandCycleCron(config.autonomy?.commandCycle?.eveningLocalTime ?? "17:30"),
      prompt: "Run the evening command cycle report."
    }
  ];
  const tasks = [...config.scheduler.tasks];
  for (const spec of specs) {
    const index = tasks.findIndex((task2) => task2.id === spec.id);
    const task = {
      id: spec.id,
      enabled,
      kind: "command-cycle",
      commandCyclePhase: spec.phase,
      schedule: spec.schedule,
      zone: "trusted",
      prompt: spec.prompt,
      notify: "none",
      silent: true
    };
    if (index >= 0) {
      tasks[index] = {
        ...tasks[index],
        ...task
      };
    } else {
      tasks.push(task);
    }
  }
  return {
    ...config,
    scheduler: {
      ...config.scheduler,
      tasks
    }
  };
}
async function loadConfig(configDir, overrides) {
  const resolvedDir = configDir.startsWith("~") ? configDir.replace("~", homedir()) : configDir;
  let fileConfig = {};
  const candidates = [
    join(resolvedDir, "zaraa.config.json"),
    join(resolvedDir, "config.json")
  ];
  for (const filePath of candidates) {
    let raw;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const text = raw.length > 0 && raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
    try {
      fileConfig = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Failed to parse config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    break;
  }
  let merged = deepMerge(
    DEFAULT_CONFIG,
    fileConfig
  );
  if (overrides) {
    merged = deepMerge(
      merged,
      overrides
    );
  }
  merged = ensureDailyCryptoDisciplineTask(merged);
  merged = ensureCreativeJoyIdleTask(merged);
  merged = ensureCommandCycleScheduleTasks(merged);
  const result = validateConfig(merged);
  for (const warning of result.warnings) {
    console.warn(`[zaraa config] WARNING: ${warning}`);
  }
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`[zaraa config] ERROR: ${err}`);
    }
    throw new Error(
      `Config validation failed (${result.errors.length} error${result.errors.length > 1 ? "s" : ""}):
` + result.errors.map((e) => `  \u2022 ${e}`).join("\n")
    );
  }
  return merged;
}
export {
  AFTERNOON_VOICE_BRIEF_MACRO_PROMPT,
  AUTONOMY_PULSE_MACRO_PROMPT,
  DEFAULT_ALERT_MANAGER_CONFIG,
  DEFAULT_CONFIG,
  DEFAULT_PROFILE,
  DEFAULT_PROVIDER_CONCURRENCY,
  DEFAULT_TRADING_CONFIG,
  HEALTH_CHECK_4H_MACRO_PROMPT,
  MORNING_VOICE_BRIEF_MACRO_PROMPT,
  NIGHT_VOICE_BRIEF_MACRO_PROMPT,
  RESEARCH_SPRINT_MACRO_PROMPT,
  SELF_HEALING_MACRO_PROMPT,
  SELF_IMPROVEMENT_MACRO_PROMPT,
  VOICE_READINESS_CAUSES,
  VOICE_READINESS_MESSAGES,
  WEEKLY_FAILURE_DEBT_SWARM_REVIEW_MACRO_PROMPT,
  WEEKLY_REVIEW_MACRO_PROMPT,
  ZONES,
  extractDesignerArtifacts,
  inferDesignerArtifactKind,
  lintDesignerHtmlArtifact,
  loadConfig,
  normalizeDesignerArtifactType,
  validateConfig,
  voiceReadinessMessage
};
