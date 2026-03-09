/**
 * Pure domain inference helpers for PMCI market metadata.
 * No side effects, no I/O, no DB.
 */

/** Derive election phase from ticker/title. */
export function inferElectionPhase(ticker, title) {
  const t = String(title || "").toLowerCase();
  const tick = String(ticker || "").toUpperCase();
  if (/primary/i.test(t) || /-PRI-/.test(tick)) return "primary";
  if (/runoff/i.test(t)) return "runoff";
  if (/special/i.test(t)) return "special";
  return "general";
}

/** Derive subject type from ticker structure and title. */
export function inferSubjectType(ticker, title) {
  const t = String(title || "").toLowerCase();
  const tick = String(ticker || "").toUpperCase();
  if (/^GOVPARTY|^SENATE.*-REP$|^SENATE.*-DEM$/.test(tick)) return "party";
  if (/nominate|appointment|appoint/i.test(t)) return "appointment";
  if (/policy|rate|decision|bill|act\b/i.test(t)) return "policy";
  return "candidate";
}
