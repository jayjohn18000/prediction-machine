/**
 * Cross-provider template compatibility (Phase E4).
 */

function normShape(template) {
  const t = String(template || "");
  return t.replace(/^(btc|eth|sol|crypto)-/, "ASSET-");
}

function parseYmd(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function dateDeltaDays(a, b) {
  const ta = parseYmd(a);
  const tb = parseYmd(b);
  if (ta == null || tb == null) return null;
  return Math.round(Math.abs(ta - tb) / 86400000);
}

function pnum(p, k) {
  const v = p?.[k];
  if (v == null) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function strikesClose(a, b) {
  const sa = pnum(a, "strike");
  const sb = pnum(b, "strike");
  if (!Number.isFinite(sa) || !Number.isFinite(sb)) return false;
  const mx = Math.max(Math.abs(sa), Math.abs(sb));
  if (mx === 0) return sa === sb;
  return Math.abs(sa - sb) / mx <= 0.1;
}

function assetsMatch(a, b) {
  const aa = a?.asset;
  const ab = b?.asset;
  if (aa && ab) return String(aa).toLowerCase() === String(ab).toLowerCase();
  return true;
}

function meetingAligned(a, b) {
  const ma = a?.meeting_date;
  const mb = b?.meeting_date;
  if (ma && mb) {
    const d = dateDeltaDays(ma, mb);
    return d != null && d <= 1;
  }
  return !ma && !mb;
}

function datesAligned(paramsA, paramsB, keys = ["date", "meeting_date", "deadline"]) {
  for (const ka of keys) {
    for (const kb of keys) {
      const va = paramsA?.[ka];
      const vb = paramsB?.[kb];
      if (va && vb) {
        const d = dateDeltaDays(va, vb);
        if (d != null && d <= 1) return true;
      }
    }
  }
  return false;
}

function alignSameTemplate(shape, paramsA, paramsB) {
  if (shape.startsWith("ASSET-interval")) {
    return { ok: false, reason: "interval_no_cross_venue" };
  }
  if (shape === "fed-personnel" || shape === "fed-dissent" || shape === "fed-rate-sequence") {
    return { ok: true, reason: "fed_special" };
  }
  if (shape === "fed-rate-decision" || shape === "fed-rate-direction" || shape === "fomc-specific") {
    if (meetingAligned(paramsA, paramsB) || datesAligned(paramsA, paramsB, ["meeting_date"])) {
      return { ok: true, reason: "fed_meeting" };
    }
    return { ok: false, reason: "fed_meeting_mismatch" };
  }
  if (shape.startsWith("ASSET-milestone")) {
    return strikesClose(paramsA, paramsB) && assetsMatch(paramsA, paramsB)
      ? { ok: true, reason: "milestone" }
      : { ok: false, reason: "milestone_params" };
  }
  if (shape.includes("price-threshold") || shape.includes("price-dip")) {
    if (!assetsMatch(paramsA, paramsB)) return { ok: false, reason: "asset_mismatch" };
    if (!strikesClose(paramsA, paramsB)) return { ok: false, reason: "strike_mismatch" };
    if (!datesAligned(paramsA, paramsB)) return { ok: false, reason: "date_mismatch" };
    return { ok: true, reason: "threshold" };
  }
  if (shape.includes("daily-range") || shape.includes("daily-direction") || shape.includes("daily-")) {
    if (!assetsMatch(paramsA, paramsB)) return { ok: false, reason: "asset_mismatch" };
    if (datesAligned(paramsA, paramsB)) return { ok: true, reason: "daily" };
    return { ok: false, reason: "date_mismatch" };
  }
  if (shape.startsWith("politics-") || shape.startsWith("sports-")) {
    return { ok: true, reason: "same_template" };
  }
  if (shape === "economics-generic" || shape === "cpi-threshold" || shape === "gdp-threshold" || shape === "recession-binary") {
    return meetingAligned(paramsA, paramsB) || datesAligned(paramsA, paramsB, ["meeting_date", "date"])
      ? { ok: true, reason: "econ" }
      : { ok: false, reason: "econ_params" };
  }
  return { ok: true, reason: "same_template_default" };
}

/**
 * @param {string} templateA
 * @param {Record<string, unknown>} paramsA
 * @param {string} templateB
 * @param {Record<string, unknown>} paramsB
 * @returns {{ compatible: boolean, reason: string }}
 */
export function areTemplatesCompatible(templateA, paramsA, templateB, paramsB) {
  const a = String(templateA || "");
  const b = String(templateB || "");
  if (!a || !b) {
    return { compatible: false, reason: "missing_template" };
  }

  const na = normShape(a);
  const nb = normShape(b);

  if (na.startsWith("ASSET-interval") || nb.startsWith("ASSET-interval")) {
    return { compatible: false, reason: "interval_isolated" };
  }

  if ((na.includes("corporate") && !nb.includes("corporate")) || (!na.includes("corporate") && nb.includes("corporate"))) {
    return { compatible: false, reason: "corporate_vs_asset" };
  }

  if ((na.includes("milestone") && (nb.includes("daily-") || nb.includes("daily"))) || (nb.includes("milestone") && (na.includes("daily-") || na.includes("daily")))) {
    return { compatible: false, reason: "milestone_vs_daily" };
  }

  if ((na === "fed-personnel") !== (nb === "fed-personnel")) {
    if (na.startsWith("fed-rate") || nb.startsWith("fed-rate") || na.includes("fomc") || nb.includes("fomc")) {
      return { compatible: false, reason: "personnel_vs_rates" };
    }
  }

  if ((na === "fed-rate-sequence" && nb === "fed-rate-decision") || (nb === "fed-rate-sequence" && na === "fed-rate-decision")) {
    return { compatible: false, reason: "sequence_vs_single" };
  }

  if (na === nb) {
    const sub = alignSameTemplate(na, paramsA || {}, paramsB || {});
    return { compatible: sub.ok, reason: sub.reason };
  }

  const pair = [na, nb].sort().join("|");

  if (pair === "ASSET-daily-direction|ASSET-daily-range") {
    if (!assetsMatch(paramsA, paramsB)) return { compatible: false, reason: "asset_mismatch" };
    if (!datesAligned(paramsA, paramsB)) return { compatible: false, reason: "date_mismatch" };
    return { compatible: true, reason: "daily_range_direction" };
  }

  if (pair === "ASSET-price-dip|ASSET-price-threshold") {
    if (!assetsMatch(paramsA, paramsB)) return { compatible: false, reason: "asset_mismatch" };
    if (!strikesClose(paramsA, paramsB)) return { compatible: false, reason: "strike_mismatch" };
    if (!datesAligned(paramsA, paramsB)) return { compatible: false, reason: "date_mismatch" };
    return { compatible: true, reason: "threshold_dip" };
  }

  if (
    (na === "fed-rate-decision" && nb === "fed-rate-direction") ||
    (na === "fed-rate-direction" && nb === "fed-rate-decision")
  ) {
    if (datesAligned(paramsA, paramsB, ["meeting_date"])) {
      return { compatible: true, reason: "fed_decision_direction" };
    }
    return { compatible: false, reason: "fed_meeting_mismatch" };
  }

  if (
    (na === "fed-rate-decision" && nb === "fomc-specific") ||
    (na === "fomc-specific" && nb === "fed-rate-decision")
  ) {
    if (datesAligned(paramsA, paramsB, ["meeting_date"])) {
      return { compatible: true, reason: "fed_fomc" };
    }
    return { compatible: false, reason: "fed_meeting_mismatch" };
  }

  return { compatible: false, reason: "no_rule" };
}
