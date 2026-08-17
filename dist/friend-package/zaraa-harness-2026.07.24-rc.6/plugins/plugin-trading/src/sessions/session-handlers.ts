import type { TradingSessionManager } from "./trading-session.js";

export interface SessionHandlerDeps {
	sessionManager: TradingSessionManager;
}

export function createSessionHandlers(deps: SessionHandlerDeps) {
	const { sessionManager } = deps;

	return {
		trade_session_start: async (
			args: Record<string, unknown>,
		): Promise<string> => {
			const name = args.name as string | undefined;

			try {
				const session = sessionManager.startSession(name);
				return JSON.stringify({
					id: session.id,
					name: session.name,
					startTime: session.startTime,
					status: session.status,
					message: `Trading session "${session.name}" started.`,
				});
			} catch (err) {
				return JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		trade_session_close: async (
			args: Record<string, unknown>,
		): Promise<string> => {
			const notes = args.notes as string | undefined;
			const sessionId = args.session_id as string | undefined;

			try {
				// If no session_id provided, close the active session
				let id = sessionId;
				if (!id) {
					const active = sessionManager.getActiveSession();
					if (!active) {
						return JSON.stringify({
							error: "No active trading session to close.",
						});
					}
					id = active.id;
				}

				const session = sessionManager.closeSession(id, notes);
				return JSON.stringify({
					id: session.id,
					name: session.name,
					startTime: session.startTime,
					endTime: session.endTime,
					status: session.status,
					notes: session.notes,
					summary: {
						tradesCount: session.tradesCount,
						winCount: session.winCount,
						lossCount: session.lossCount,
						winRate:
							session.tradesCount > 0
								? Math.round(
										(session.winCount / session.tradesCount) *
											10000,
									) / 100
								: 0,
						totalPnl: session.totalPnl,
						maxDrawdown: session.maxDrawdown,
						bestTrade: session.bestTrade,
						worstTrade: session.worstTrade,
					},
					message: `Session "${session.name}" closed. ${session.tradesCount} trades, P&L: $${session.totalPnl}.`,
				});
			} catch (err) {
				return JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		trade_session_status: async (
			_args: Record<string, unknown>,
		): Promise<string> => {
			try {
				const active = sessionManager.getActiveSession();
				if (!active) {
					return JSON.stringify({
						active: false,
						message:
							"No active trading session. Use trade_session_start to begin one.",
					});
				}

				const stats = sessionManager.getSessionStats(active.id);
				const durationMs =
					Date.now() - new Date(active.startTime).getTime();
				const durationMin = Math.round(durationMs / 60_000);
				const hours = Math.floor(durationMin / 60);
				const mins = durationMin % 60;
				const durationStr =
					hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

				return JSON.stringify({
					active: true,
					session: {
						id: active.id,
						name: active.name,
						startTime: active.startTime,
						duration: durationStr,
					},
					stats,
				});
			} catch (err) {
				return JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		trade_session_list: async (
			args: Record<string, unknown>,
		): Promise<string> => {
			try {
				const limit = (args.limit as number) || 10;
				const includeWeekly = args.include_weekly !== false;

				const sessions = sessionManager.listSessions(limit);

				if (sessions.length === 0) {
					return JSON.stringify({
						sessions: [],
						message: "No trading sessions found.",
					});
				}

				const result: Record<string, unknown> = {
					sessions: sessions.map((s) => ({
						id: s.id,
						name: s.name,
						startTime: s.startTime,
						endTime: s.endTime,
						status: s.status,
						tradesCount: s.tradesCount,
						totalPnl: s.totalPnl,
						winRate:
							s.tradesCount > 0
								? Math.round(
										(s.winCount / s.tradesCount) * 10000,
									) / 100
								: 0,
					})),
				};

				if (includeWeekly) {
					result.weeklySummary = sessionManager.getWeeklySummary();
				}

				return JSON.stringify(result);
			} catch (err) {
				return JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},

		trade_session_review: async (
			args: Record<string, unknown>,
		): Promise<string> => {
			try {
				let id = args.session_id as string | undefined;

				// If no id provided, review the most recent closed session or the active one
				if (!id) {
					const active = sessionManager.getActiveSession();
					if (active) {
						id = active.id;
					} else {
						const sessions = sessionManager.listSessions(1);
						if (sessions.length === 0) {
							return JSON.stringify({
								error: "No trading sessions found to review.",
							});
						}
						id = sessions[0].id;
					}
				}

				const review = sessionManager.getSessionReview(id);

				return JSON.stringify({
					session: {
						id: review.session.id,
						name: review.session.name,
						startTime: review.session.startTime,
						endTime: review.session.endTime,
						status: review.session.status,
						notes: review.session.notes,
					},
					stats: review.stats,
					timeline: review.timeline,
					tradesCount: review.trades.length,
				});
			} catch (err) {
				return JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}

// ── Tool definitions for the plugin manifest ──

export const sessionToolDefinitions = [
	{
		name: "trade_session_start",
		description:
			"Start a new trading session to group and track trades during a focused trading period (e.g., morning session, market open). Only one session can be active at a time.",
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description:
						'Optional session name (e.g., "Morning scalps", "Asian session"). Auto-generated if omitted.',
				},
			},
			required: [],
		},
		requiresApproval: false,
	},
	{
		name: "trade_session_close",
		description:
			"Close the active trading session. Computes final stats: win rate, total P&L, max drawdown, best/worst trade. Optionally add notes for the session review.",
		parameters: {
			type: "object",
			properties: {
				session_id: {
					type: "string",
					description:
						"Session ID to close. If omitted, closes the currently active session.",
				},
				notes: {
					type: "string",
					description:
						'Optional notes for the session (e.g., "Choppy market, should have sat out after 3rd loss").',
				},
			},
			required: [],
		},
		requiresApproval: false,
	},
	{
		name: "trade_session_status",
		description:
			"Get the current active session's status including live stats: trade count, win rate, P&L, breakdown by symbol and tag, and session duration.",
		parameters: {
			type: "object",
			properties: {},
			required: [],
		},
		requiresApproval: false,
	},
	{
		name: "trade_session_list",
		description:
			"List recent trading sessions with their stats. Includes a weekly summary with best/worst day and overall win rate.",
		parameters: {
			type: "object",
			properties: {
				limit: {
					type: "number",
					description: "Number of sessions to return (default: 10)",
				},
				include_weekly: {
					type: "boolean",
					description:
						"Include weekly summary in the response (default: true)",
				},
			},
			required: [],
		},
		requiresApproval: false,
	},
	{
		name: "trade_session_review",
		description:
			"Get a detailed review of a specific trading session: full trade timeline, per-symbol and per-tag breakdowns, win rate, P&L curve, and session notes.",
		parameters: {
			type: "object",
			properties: {
				session_id: {
					type: "string",
					description:
						"Session ID to review. If omitted, reviews the active session or most recent closed session.",
				},
			},
			required: [],
		},
		requiresApproval: false,
	},
];
