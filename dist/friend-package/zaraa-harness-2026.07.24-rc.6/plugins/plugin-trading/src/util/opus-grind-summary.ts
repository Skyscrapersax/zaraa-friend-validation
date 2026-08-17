import { z } from "zod";

export const opusGrindSummaryNestedSchema = z
	.object({
		parameterTweak: z
			.object({
				strategy: z.string(),
				param: z.string(),
				oldValue: z.union([z.string(), z.number()]).optional(),
				newValue: z.union([z.string(), z.number()]).optional(),
				reasoning: z.string(),
			})
			.optional(),
		creativeAlpha: z
			.object({
				name: z.string(),
				thesis: z.string(),
				entryLogic: z.string(),
				risk: z.string(),
				capitalNeeded: z.string(),
			})
			.optional(),
		repeatFailurePattern: z
			.object({
				patternKey: z.string().min(1),
				description: z.string(),
				occurrenceCount: z.number().int().min(1),
				recommendedFix: z.string().optional(),
			})
			.optional(),
		/** Structured payload from trade_quiet_hours_risk_audit (optional). */
		quietHoursRiskAudit: z
			.object({
				exposureByAsset: z
					.record(
						z.string(),
						z.object({
							notionalUsd: z.number(),
							pctOfGross: z.number(),
						}),
					)
					.optional(),
				violations: z
					.array(
						z.object({
							code: z.string(),
							severity: z.enum(["critical", "high", "medium", "low"]),
							detail: z.string(),
							symbol: z.string().optional(),
						}),
					)
					.optional(),
				escalationRecommended: z.boolean().optional(),
				stepsCompletedLabels: z.array(z.string()).optional(),
				stepsSkippedLabels: z.array(z.string()).optional(),
				benchmarkPricesSkipped: z.boolean().optional(),
			})
			.optional(),
		benchmarkPrices: z
			.array(
				z.object({
					symbol: z.string(),
					price: z.number().nullable(),
					error: z.string().optional(),
				}),
			)
			.optional(),
		notes: z.string().optional(),
		regimeNote: z.string().optional(),
	})
	.strip();

export type OpusGrindSummaryNested = z.infer<typeof opusGrindSummaryNestedSchema>;

export type OpusGrindCanonicalSummaryV1 = OpusGrindSummaryNested & {
	schemaVersion: 1;
	cycleMode: "lightweight" | "full";
	quietHoursActive: boolean;
	quietHoursWindow: { start: string; end: string };
};
