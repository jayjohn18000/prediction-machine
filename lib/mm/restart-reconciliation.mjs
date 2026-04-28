/**
 * Orchestrator reconcile pass after process restart vs Kalshi + DB.
 *
 * Full implementation lands in W3 alongside live orchestrator state.
 *
 * @returns {Promise<{ skipped: boolean, phase: string }>}
 */
export async function reconcileOnRestart() {
  return { skipped: true, phase: "W3" };
}
