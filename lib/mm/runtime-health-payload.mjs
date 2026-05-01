/**
 * Build Fastify /health/mm JSON (orchestrator runtime + optional depth snapshot).
 */

/**
 * @param {object} p
 * @param {Record<string, unknown>} p.health in-memory orchestrator health object
 * @param {Record<string, unknown> | null | undefined} p.depthSnap from depth `getHealthSnapshot()`
 */
export function buildMmHealthMmResponse(p) {
  const { health, depthSnap } = p;
  const h = /** @type {any} */ (health);
  const configured = depthSnap?.depthSubscribedConfigured ?? h.depthSubscribedTickers ?? 0;
  const connected = depthSnap?.depthSubscribedConnected ?? 0;
  const staleRaw = depthSnap?.depthTickersStale ?? h.depthTickersStale;
  const staleArr = Array.isArray(staleRaw) ? staleRaw : staleRaw ? [staleRaw] : [];

  const baseOk = h.lastOrchestratorError ? false : health.ok !== false;

  const loopTickAt = h.lastMainLoopTickAt != null ? new Date(String(h.lastMainLoopTickAt)).getTime() : NaN;
  const loopAgeMs = Number.isFinite(loopTickAt) ? Date.now() - loopTickAt : Number.POSITIVE_INFINITY;

  const depthConnectedOk = connected === configured;
  const depthStaleOk = staleArr.length === 0;
  const loopFresh = loopAgeMs < 30_000;

  const ready = baseOk && depthConnectedOk && depthStaleOk && loopFresh;

  /** @type {"none" | "warn" | "crit"} */
  let severity = "none";
  if (!baseOk || loopAgeMs >= 60_000) severity = "crit";
  else if (!ready) severity = "warn";

  const out = {
    ok: baseOk,
    ...health,
    ...(depthSnap ?? {}),
    depthSubscribedTickers: configured,
    depthSubscribedConfigured: depthSnap?.depthSubscribedConfigured ?? configured,
    depthSubscribedConnected: depthSnap?.depthSubscribedConnected ?? 0,
    depthLastUpdateSecondsAgo: depthSnap?.depthLastUpdateSecondsAgo ?? h.depthLastUpdateSecondsAgo,
    depthTickersStale: depthSnap?.depthTickersStale ?? h.depthTickersStale,
    ready,
    severity,
  };
  /** `...health` may have reintroduced a stale `ok`; keep the orchestrator-error contract. */
  out.ok = baseOk;
  return out;
}
