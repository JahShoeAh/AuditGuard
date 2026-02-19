/*
 * Mock events are intentionally disabled.
 * This module remains as a no-op shim to preserve imports.
 */

export const CYCLE_DURATION_MS = 0;

export function startMockEventStream() {
  console.warn("[mock-events] Disabled. No mock events will be emitted.");
  return () => {};
}
