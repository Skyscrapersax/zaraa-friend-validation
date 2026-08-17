import type { RiskConfig } from "./risk-manager.js";

/**
 * Snapshot of risk configuration captured at the start of a trade lifecycle.
 * Prevents TOCTOU issues where config changes mid-trade cause validation
 * against stale or mismatched limits.
 */
export interface ConfigSnapshot {
  /** Frozen copy of the risk config at capture time */
  readonly config: Readonly<RiskConfig>;
  /** ISO timestamp when the snapshot was taken */
  readonly capturedAt: string;
  /** Whether the live config has diverged since capture */
  diverged: boolean;
}

/**
 * Captures a frozen snapshot of the current risk config for use throughout
 * a single trade's lifecycle. The snapshot is immutable — any mutations to
 * the live RiskManager config after capture will not affect it.
 *
 * @param currentConfig - The live risk config (typically from RiskManager.getConfig())
 * @param nowMs - Optional clock override for testing
 */
export function captureConfigSnapshot(
  currentConfig: RiskConfig,
  nowMs?: number,
): ConfigSnapshot {
  // Deep-freeze a copy so no caller can mutate it
  const frozen = Object.freeze({ ...currentConfig });
  return {
    config: frozen,
    capturedAt: new Date(nowMs ?? Date.now()).toISOString(),
    diverged: false,
  };
}

/**
 * Checks whether the live config has changed relative to a snapshot.
 * If it has, marks the snapshot as diverged and returns a list of
 * changed field names for logging.
 *
 * @param snapshot - The previously captured snapshot
 * @param liveConfig - The current live config to compare against
 * @returns Array of field names that differ (empty if unchanged)
 */
export function checkConfigDivergence(
  snapshot: ConfigSnapshot,
  liveConfig: RiskConfig,
): string[] {
  const changed: string[] = [];
  const snapKeys = Object.keys(snapshot.config) as (keyof RiskConfig)[];

  for (const key of snapKeys) {
    if (snapshot.config[key] !== liveConfig[key]) {
      changed.push(key);
    }
  }

  // Also detect keys added to live config after snapshot
  for (const key of Object.keys(liveConfig) as (keyof RiskConfig)[]) {
    if (!(key in snapshot.config) && !changed.includes(key)) {
      changed.push(key);
    }
  }

  if (changed.length > 0) {
    snapshot.diverged = true;
    console.warn(
      `[config-fence] Config diverged during active trade ` +
      `(snapshot from ${snapshot.capturedAt}): ${changed.join(", ")}`,
    );
  }

  return changed;
}
