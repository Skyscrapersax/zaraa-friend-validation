import { loadavg } from "node:os";

const DEFAULT_HOST_LOAD_THRESHOLD = 8;
const HOST_LOAD_THRESHOLD_ENV = "ZARAA_STUDIO_RENDER_LOAD_THRESHOLD";

/** 1-minute load average for this host. */
export function getLoadAverage(): number {
  return loadavg()[0];
}

function hostLoadThreshold(): number {
  const raw = process.env[HOST_LOAD_THRESHOLD_ENV];
  if (raw === undefined) return DEFAULT_HOST_LOAD_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOST_LOAD_THRESHOLD;
}

/**
 * True when the host's 1-min load average is at or above `threshold`.
 * `read` is injectable for testing. Default threshold 8 suits this 16GB
 * host that also runs the daemon + local models.
 */
export function isHostBusy(threshold?: number, read: () => number = getLoadAverage): boolean {
  return read() >= (threshold ?? hostLoadThreshold());
}
