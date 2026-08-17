import type { GuiActionEvent } from "./policy-guard.js";

export interface RecentActionsBuffer {
  push(event: GuiActionEvent): void;
  snapshot(): GuiActionEvent[];
  clear(): void;
}

/**
 * Bounded FIFO of the most recent N GUI action events. Oldest events are
 * dropped when capacity is exceeded. `snapshot()` returns a defensive copy
 * — callers are free to mutate it.
 */
export function createRecentActionsBuffer(capacity: number): RecentActionsBuffer {
  if (capacity < 1) {
    throw new Error(`recent-actions buffer capacity must be >= 1 (got ${capacity})`);
  }
  const items: GuiActionEvent[] = [];
  return {
    push(event) {
      items.push(event);
      if (items.length > capacity) items.shift();
    },
    snapshot() {
      return items.slice();
    },
    clear() {
      items.length = 0;
    },
  };
}
