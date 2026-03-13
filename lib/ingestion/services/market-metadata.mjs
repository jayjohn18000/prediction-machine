/**
 * Pure domain inference helpers for PMCI market metadata.
 * No side effects, no I/O, no DB.
 */

const STATE_NAME_TO_CODE = new Map([
  ["alabama", "al"], ["alaska", "ak"], ["arizona", "az"], ["arkansas", "ar"],
  ["california", "ca"], ["colorado", "co"], ["connecticut", "ct"], ["delaware", "de"],
  ["florida", "fl"], ["georgia", "ga"], ["hawaii", "hi"], ["idaho", "id"],
  ["illinois", "il"], ["indiana", "in"], ["iowa", "ia"], ["kansas", "ks"],
  ["kentucky", "ky"], ["louisiana", "la"], ["maine", "me"], ["maryland", "md"],
  ["massachusetts", "ma"], ["michigan", "mi"], ["minnesota", "mn"], ["mississippi", "ms"],
  ["missouri", "mo"], ["montana", "mt"], ["nebraska", "ne"], ["nevada", "nv"],
  ["new hampshire", "nh"], ["new jersey", "nj"], ["new mexico", "nm"], ["new york", "ny"],
  ["north carolina", "nc"], ["north dakota", "nd"], ["ohio", "oh"], ["oklahoma", "ok"],
  ["oregon", "or"], ["pennsylvania", "pa"], ["rhode island", "ri"], ["south carolina", "sc"],
  ["south dakota", "sd"], ["tennessee", "tn"], ["texas", "tx"], ["utah", "ut"],
  ["vermont", "vt"], ["virginia", "va"], ["washington", "wa"], ["west virginia", "wv"],
  ["wisconsin", "wi"], ["wyoming", "wy"], ["district of columbia", "dc"],
]);

const STATE_CODE_TO_NAME_SLUG = new Map([...STATE_NAME_TO_CODE.entries()].map(([name, code]) => [code, name.replace(/\s+/g, "_")]));

function inferYear(text) {
  const m = String(text || "").match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function inferStateCode(text) {
  const t = String(text || "").toLowerCase();
  const cleaned = t.replace(/[^a-z0-9]+/g, ' ');

  for (const [name, code] of STATE_NAME_TO_CODE.entries()) {
    if (cleaned.includes(` ${name} `) || cleaned.startsWith(`${name} `) || cleaned.endsWith(` ${name}`) || cleaned === name) {
      return code;
    }
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const validCodes = new Set(["al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc"]);
  for (const tok of tokens) {
    if (validCodes.has(tok)) return tok;
  }

  return null;
}

function inferOffice(text) {
  const t = String(text || "").toLowerCase();
  if (/\bpresident|presidential|white house\b/.test(t)) return "president";
  if (/\bsenate|senator\b/.test(t)) return "senate";
  if (/\bgovernor|gubernatorial|govparty\b/.test(t)) return "governor";
  if (/\bhouse|congress(ional)?\s+district|representative\b/.test(t)) return "house";
  return "other_politics";
}

function slugPart(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

/**
 * Enriched political metadata for deterministic normalization.
 */
export function inferPoliticalMetadata(eventRef, title) {
  const combined = `${String(eventRef || "")} ${String(title || "")}`;
  const lc = combined.toLowerCase();

  const electionPhase = inferElectionPhase(eventRef, title);
  const office = inferOffice(combined);
  const inferredStateCode = inferStateCode(combined);
  const stateCode = office === "president" ? null : inferredStateCode;
  const year = inferYear(combined) ?? (office === "president" ? 2028 : 2026);

  const jurisdiction = stateCode ? `us_state_${stateCode}` : "us_federal";
  const stateNameSlug = stateCode ? (STATE_CODE_TO_NAME_SLUG.get(stateCode) || stateCode) : null;

  let normalizedEventKey;
  if (office === "president") {
    normalizedEventKey = `president_us_${year}`;
  } else if (office === "senate") {
    normalizedEventKey = `senate_${stateNameSlug || "us"}_${year}`;
  } else if (office === "governor") {
    normalizedEventKey = `gov_${stateNameSlug || "us"}_${year}`;
  } else if (office === "house") {
    normalizedEventKey = `house_${stateNameSlug || "us"}_${year}`;
  } else {
    normalizedEventKey = `other_politics_${slugPart(eventRef || title || "unknown")}_${year}`;
  }

  // Keep DB-compatible subject_type values while adding richer office classification in metadata.
  const subjectType = office === "other_politics"
    ? (/\bpolicy|rate|decision|bill|act\b/.test(lc) ? "policy" : "unknown")
    : "candidate";

  return {
    electionPhase,
    subjectType,
    office,
    jurisdiction,
    year,
    normalizedEventKey,
  };
}

/** Derive election phase from ticker/title. */
export function inferElectionPhase(ticker, title) {
  const t = String(title || "").toLowerCase();
  const tick = String(ticker || "").toUpperCase();
  if (/primary/i.test(t) || /-PRI-/.test(tick) || /\bnominee\b/.test(t)) return "primary";
  if (/runoff/i.test(t)) return "runoff";
  if (/special/i.test(t)) return "special";
  if (/\bnomination\b/.test(t)) return "primary";
  if (/\bgeneral\b/.test(t)) return "general";
  return "unknown";
}

/** Derive subject type from ticker structure and title. */
export function inferSubjectType(ticker, title) {
  return inferPoliticalMetadata(ticker, title).subjectType;
}
