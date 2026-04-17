/**
 * Rule-based economics / macro template classifier (Phase E4).
 */

function extractDate(text) {
  const t = String(text || "");
  let m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (m) {
    const mm = String(m[1]).padStart(2, "0");
    const dd = String(m[2]).padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})\b/i);
  if (m) {
    const months = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const mo = months[m[1].toLowerCase().slice(0, 3)];
    if (mo) {
      const dd = String(m[2]).padStart(2, "0");
      return `${m[3]}-${mo}-${dd}`;
    }
  }
  return null;
}

/** FOMC / Fed meeting month+year */
function extractMeetingHint(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(20\d{2})\s+(fomc|meeting)\b/);
  if (m) return `${m[2]}-${m[1].slice(0, 3)}`;
  if (/\bfomc\b/i.test(t)) {
    const d = extractDate(text);
    return d || null;
  }
  return extractDate(text);
}

export function classifyTemplate(market) {
  const title = String(market?.title || "");
  const ref = String(market?.provider_market_ref || "");
  const combined = `${title} ${ref}`;
  const t = combined.toLowerCase();

  if (/\b(powell|brainard|waller|bowman|jefferson|kugler)\b.*\b(chair|governor|fed|nominate|confirmed|leave|resign|step down)\b/i.test(combined)) {
    return {
      template: "fed-personnel",
      params: { person: "unknown", role: "fed", action: "unknown" },
    };
  }

  if (/\bpause[- ]cut[- ]cut\b|\bthree\s+decisions\b|\bsequence\b.*\b(fed|fomc|rate)\b/i.test(combined)) {
    return { template: "fed-rate-sequence", params: { sequence: [], meetings: [] } };
  }

  if (/\bdissent\b|\bdissenters?\b/i.test(combined) && /\b(fed|fomc|meeting)\b/i.test(combined)) {
    const meeting_date = extractMeetingHint(combined);
    return { template: "fed-dissent", params: { count: null, meeting_date } };
  }

  if (/\b(increase|decrease|raise|lower)\b.*\b(rate|rates)\b.*\b(after|following)\b/i.test(combined)) {
    const meeting_date = extractMeetingHint(combined);
    let direction = null;
    if (/\braise|increase|hike\b/i.test(combined)) direction = "up";
    if (/\blower|decrease|cut\b/i.test(combined)) direction = "down";
    return { template: "fed-rate-direction", params: { direction, meeting_date } };
  }

  if (/\bfomc\b|\bfed\s*(rate|decision|meeting)\b|\b(fed|fomc)\b.*\b(hold|hike|cut|bps|basis)\b/i.test(combined)) {
    const meeting_date = extractMeetingHint(combined);
    let action = null;
    let bps = null;
    if (/\bhold|no\s*change|unchanged\b/i.test(combined)) action = "hold";
    if (/\bcut|decrease|lower\b/i.test(combined)) action = "cut";
    if (/\bhike|increase|raise\b/i.test(combined)) action = "hike";
    const bpsM = combined.match(/\b(\d+)\s*bps\b/i);
    if (bpsM) bps = Number(bpsM[1]);
    return {
      template: "fed-rate-decision",
      params: { action, bps, meeting_date },
    };
  }

  if (/\bcpi\b|\bconsumer\s+price\b/i.test(combined)) {
    const meeting_date = extractDate(combined);
    return { template: "cpi-threshold", params: { meeting_date } };
  }

  if (/\bgdp\b/i.test(combined)) {
    return { template: "gdp-threshold", params: { meeting_date: extractDate(combined) } };
  }

  if (/\brecession\b/i.test(combined)) {
    return { template: "recession-binary", params: { meeting_date: extractDate(combined) } };
  }

  if (/\b(fed|fomc|interest\s+rate|macro|inflation|nfp|jobs\s+report|unemployment)\b/i.test(combined)) {
    return {
      template: "economics-generic",
      params: { meeting_date: extractMeetingHint(combined) },
    };
  }

  return null;
}
