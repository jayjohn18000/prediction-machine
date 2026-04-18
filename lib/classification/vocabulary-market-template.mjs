/**
 * Structural template classification for provider_markets export reports.
 * Vocabulary matches docs/phase-e4 style template keys (see user-facing classification spec).
 *
 * @param {object} row
 * @returns {{ market_template: string | null, template_params: Record<string, unknown>, classification_confidence: number | null }}
 */
import { classifyMarketTypeBucket, sportsEntityFromMarket, SPORTS_BUCKET_TO_TEMPLATE } from "../matching/sports-helpers.mjs";

function normCat(c) {
  return String(c || "").toLowerCase();
}

/**
 * pmci.category is often a granular slug (e.g. democratic-presidential-nominee-2028)
 * rather than the coarse bucket "politics". Map obvious election/politics slugs.
 */
function effectiveCategoryBucket(row) {
  const cat = normCat(row.category);
  const known = new Set(["crypto", "economics", "sports", "politics"]);
  if (known.has(cat)) return cat;
  const slug = cat;
  if (
    /(election|elector|senate|house|governor|mayor|nominee|presidential|primary|democrat|republican|congress|parliament|cabinet|impeach|ballot|referendum)/i.test(
      slug,
    )
  ) {
    return "politics";
  }
  return cat;
}

function combinedText(row) {
  return [row.title, row.provider_market_ref, row.event_ref].map((s) => String(s || "")).join(" ");
}

/** @param {unknown} v */
function gameDateStr(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// --- shared extractors ---

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

function extractStrike(text) {
  const t = String(text || "");
  let m = t.match(/\$\s*([\d,]+(?:\.\d+)?)\s*K\b/i);
  if (m) return parseFloat(m[1].replace(/,/g, "")) * 1000;
  m = t.match(/\$\s*([\d,]+(?:\.\d+)?)\b/);
  if (m) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (v > 0 && v < 1000 && /(bitcoin|btc|ethereum|eth|solana|sol|hit|above|below|dip)/i.test(t)) {
      v *= 1000;
    }
    return v;
  }
  m = t.match(/[↑↓]\s*\$\s*([\d,]+(?:\.\d+)?)/i);
  if (m) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    if (v > 0 && v < 1000) v *= 1000;
    return v;
  }
  return null;
}

const ASSET_PATTERNS = [
  { key: "btc", re: /\b(bitcoin|btc)\b/i },
  { key: "eth", re: /\b(ethereum|eth)\b/i },
  { key: "sol", re: /\b(solana|sol)\b/i },
];

function detectAsset(text) {
  const t = String(text || "");
  for (const { key, re } of ASSET_PATTERNS) {
    if (re.test(t)) return key;
  }
  return null;
}

function prefixForAsset(asset) {
  if (asset === "eth") return "eth";
  if (asset === "sol") return "sol";
  return "btc";
}

function classifyCrypto(row, text) {
  const asset = detectAsset(text);
  const ap = prefixForAsset(asset);
  const confExact = 0.95;
  const confStrong = 0.88;
  const confFuzzy = 0.78;

  if (/\bbtc\s+etf|etf.*\bbtc\b|bitcoin\s+etf|spot\s+bitcoin\s+etf|ibit\b/i.test(text) && asset) {
    const threshold = extractStrike(text);
    return {
      market_template: "crypto-etf",
      template_params: { asset, metric: "aum", threshold },
      classification_confidence: threshold != null ? confExact : confFuzzy,
    };
  }

  if (/\b(microstrategy|mstr|coinbase|blackrock)\b/i.test(text) && asset) {
    let company = "unknown";
    if (/\bmicrostrategy|mstr\b/i.test(text)) company = "microstrategy";
    if (/\bcoinbase\b/i.test(text)) company = "coinbase";
    if (/\bblackrock\b/i.test(text)) company = "blackrock";
    return {
      market_template: "crypto-corporate",
      template_params: { asset, company },
      classification_confidence: /mstr|microstrategy/i.test(text) ? confExact : confStrong,
    };
  }

  if (/\b(which|or)\b.*\b(btc|eth|bitcoin|ethereum).*\b(ath|all[- ]time high)\b/i.test(text)) {
    const assets = [];
    if (/\bbtc|bitcoin\b/i.test(text)) assets.push("btc");
    if (/\beth|ethereum\b/i.test(text)) assets.push("eth");
    return {
      market_template: "crypto-comparative",
      template_params: { assets: assets.length ? assets : ["btc", "eth"], comparative: true },
      classification_confidence: confStrong,
    };
  }

  if (/\binterval\b|\d+\s*min(ute)?s?\b.*\b(up or down|up\/down)\b/i.test(text) || /up or down\s*-\s*\d{1,2}:\d{2}/i.test(text)) {
    const datetime_start = extractDate(text);
    return {
      market_template: `${ap}-interval`,
      template_params: { asset: asset || "btc", datetime_start, interval_minutes: 5 },
      classification_confidence: datetime_start ? confExact : confFuzzy,
    };
  }

  if (/\ball[- ]time high\b|\bath\b|\bhit\s+\$?\s*[\d,]+.*\bby\b/i.test(text) && asset) {
    const strike = extractStrike(text);
    const deadline = extractDate(text);
    return {
      market_template: `${ap}-milestone`,
      template_params: { asset, strike, deadline },
      classification_confidence: strike && deadline ? confExact : confStrong,
    };
  }

  if (/\bdip(s)?\s+to\s+\$/i.test(text) && asset) {
    const strike = extractStrike(text);
    const date = extractDate(text);
    return {
      market_template: `${ap}-price-dip`,
      template_params: { asset, strike, date },
      classification_confidence: strike ? confExact : confFuzzy,
    };
  }

  if (
    (/\babove\b|\bbelow\b|\bover\b|\bunder\b/i.test(text) && /\$/.test(text)) ||
    /(above|below)\s+\$?\s*[\d,]+/i.test(text)
  ) {
    if (asset) {
      const strike = extractStrike(text);
      const date = extractDate(text);
      let direction = null;
      if (/\babove\b|\bover\b|\bexceed/i.test(text)) direction = "above";
      if (/\bbelow\b|\bunder\b/i.test(text)) direction = "below";
      return {
        market_template: `${ap}-price-threshold`,
        template_params: { asset, date, strike, direction },
        classification_confidence: strike && direction && date ? confExact : confStrong,
      };
    }
  }

  if (/\bup or down\b/i.test(text) && asset) {
    const date = extractDate(text);
    return {
      market_template: `${ap}-daily-direction`,
      template_params: { asset, date },
      classification_confidence: date ? confExact : confStrong,
    };
  }

  if (/\b(price )?range\b|\bbetween\s+\$/i.test(text) && asset) {
    const date = extractDate(text);
    return {
      market_template: `${ap}-daily-range`,
      template_params: { asset, date },
      classification_confidence: date ? confExact : confStrong,
    };
  }

  if (/\bprice\b.*\bon\b/i.test(text) && asset && extractDate(text)) {
    const date = extractDate(text);
    return {
      market_template: `${ap}-daily-range`,
      template_params: { asset, date },
      classification_confidence: confStrong,
    };
  }

  // Polymarket hourly / intraday: "Ethereum price at Apr 19, 2026 at 12am EDT?"
  if (asset && /\bprice at\b/i.test(text)) {
    const date = extractDate(text);
    if (date) {
      return {
        market_template: `${ap}-daily-range`,
        template_params: { asset, date },
        classification_confidence: confFuzzy,
      };
    }
  }

  return { market_template: null, template_params: {}, classification_confidence: null };
}

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

function classifyEconomics(row, text) {
  const confE = 0.94;
  const confM = 0.82;
  const confL = 0.72;

  if (/\b(powell|brainard|waller|bowman|jefferson|kugler)\b.*\b(chair|governor|fed|nominate|confirmed|leave|resign|step down)\b/i.test(text)) {
    return {
      market_template: "fed-personnel",
      template_params: { person: "unknown", action: "unknown" },
      classification_confidence: confM,
    };
  }

  if (/\bpause[- ]cut[- ]cut\b|\bthree\s+decisions\b|\bsequence\b.*\b(fed|fomc|rate)\b/i.test(text)) {
    return {
      market_template: "fed-rate-sequence",
      template_params: { sequence: [], count: 3 },
      classification_confidence: confL,
    };
  }

  if (/\bdissent\b|\bdissenters?\b/i.test(text) && /\b(fed|fomc|meeting)\b/i.test(text)) {
    const meeting_date = extractMeetingHint(text);
    const countM = text.match(/\b(\d+)\s+(people|members)\b/i);
    return {
      market_template: "fed-dissent",
      template_params: { count: countM ? Number(countM[1]) : null, meeting_date },
      classification_confidence: meeting_date ? confM : confL,
    };
  }

  if (/\b(increase|decrease|raise|lower)\b.*\b(rate|rates)\b.*\b(after|following)\b/i.test(text)) {
    const meeting_date = extractMeetingHint(text);
    let direction = null;
    if (/\braise|increase|hike\b/i.test(text)) direction = "increase";
    if (/\blower|decrease|cut\b/i.test(text)) direction = "decrease";
    return {
      market_template: "fed-rate-direction",
      template_params: { direction, meeting_date },
      classification_confidence: direction && meeting_date ? confE : confM,
    };
  }

  if (/\bfomc\b|\bfed\s*(rate|decision|meeting)\b|\b(fed|fomc)\b.*\b(hold|hike|cut|bps|basis)\b/i.test(text)) {
    const meeting_date = extractMeetingHint(text);
    let action = null;
    let bps = null;
    if (/\bhold|no\s*change|unchanged\b/i.test(text)) action = "hold";
    if (/\bcut|decrease|lower\b/i.test(text)) action = "cut";
    if (/\bhike|increase|raise\b/i.test(text)) action = "hike";
    const bpsM = text.match(/\b(\d+)\s*bps\b/i);
    if (bpsM) bps = Number(bpsM[1]);
    return {
      market_template: "fed-rate-decision",
      template_params: { action, bps, meeting_date },
      classification_confidence: action && meeting_date ? confE : confM,
    };
  }

  if (/\bcpi\b|\bconsumer\s+price\b/i.test(text)) {
    let direction = null;
    if (/\babove|over|exceed|greater\b/i.test(text)) direction = "above";
    if (/\bbelow|under\b/i.test(text)) direction = "below";
    const vm = text.match(/\b(\d+\.?\d*)\s*%/);
    const value = vm ? Number(vm[1]) : null;
    return {
      market_template: "cpi-threshold",
      template_params: { metric: "cpi", value, direction },
      classification_confidence: value != null && direction ? confE : confM,
    };
  }

  if (/\bgdp\b/i.test(text)) {
    let direction = null;
    if (/\babove|over|exceed/i.test(text)) direction = "above";
    if (/\bbelow|under/i.test(text)) direction = "below";
    const vm = text.match(/\b(-?\d+\.?\d*)\s*%/);
    const value = vm ? Number(vm[1]) : null;
    return {
      market_template: "gdp-threshold",
      template_params: { metric: "gdp", value, direction },
      classification_confidence: value != null ? confE : confM,
    };
  }

  if (/\brecession\b/i.test(text)) {
    const deadline = extractDate(text);
    return {
      market_template: "recession-binary",
      template_params: { deadline },
      classification_confidence: deadline ? confM : confL,
    };
  }

  return { market_template: null, template_params: {}, classification_confidence: null };
}

function classifySports(row, text) {
  const se = sportsEntityFromMarket(row);
  const sport = String(row.sport || se.sport || "").toLowerCase() || null;
  const game_date = gameDateStr(row.game_date) || se.gameDate || null;
  const home_team = row.home_team || se.home || null;
  const away_team = row.away_team || se.away || null;

  const baseParams = {
    sport: sport || "unknown",
    home_team: home_team || null,
    away_team: away_team || null,
    game_date,
  };

  const confHigh = 0.92;
  const confMid = 0.84;
  const confLow = 0.72;

  // Player props: points, yards, goals, etc.
  if (
    /\b(points|yards|receptions|touchdowns?|goals|assists|hits|strikeouts|home runs?)\b/i.test(text) &&
    /\b(over|under|at least|more than|fewer)\b/i.test(text)
  ) {
    const statM = text.match(/\b([a-z]+)\s*(?:over|under)/i);
    return {
      market_template: "sports-player-prop",
      template_params: {
        ...baseParams,
        player: null,
        stat: statM ? statM[1] : "unknown",
        threshold: null,
      },
      classification_confidence: confMid,
    };
  }

  // Pro draft: pick slot / top-N picks (null-cluster: who will be picked Nth… draft)
  if (
    (/\bwho will be picked\b/i.test(text) && /\bdraft\b/i.test(text)) ||
    /\btop\s+\d+\s+.*\bdraft picks\b/i.test(text)
  ) {
    let draft_league = null;
    if (/\b(pro football|nfl)\b/i.test(text)) draft_league = "nfl";
    else if (/\b(pro basketball|nba)\b/i.test(text)) draft_league = "nba";
    const yearM = text.match(/\b(20\d{2})\b/);
    return {
      market_template: "sports-draft-pick",
      template_params: {
        ...baseParams,
        draft_league,
        year: yearM ? yearM[1] : null,
      },
      classification_confidence: confMid,
    };
  }

  // Player / coach next team, transfer destination
  if (/\bwhat will be\b.*\bnext team\b/i.test(text) || /\bwhere will\b.*\bgo next\b/i.test(text)) {
    return {
      market_template: "sports-next-team",
      template_params: {
        ...baseParams,
        prompt: String(row.title || "").slice(0, 200),
      },
      classification_confidence: confMid,
    };
  }

  // Esports map-level props (LoL, Dota 2, etc.)
  const titleTrim = String(row.title || "").trim();
  if (
    /^game\s+\d+\s*:/i.test(titleTrim) &&
    /\b(quadra kill|penta kill|baron nashor|slay a dragon|destroy inhibitors|beat roshan|destroy barracks|ultra kill|rampage|first blood|ends in daytime)\b/i.test(text)
  ) {
    return {
      market_template: "sports-esports-event",
      template_params: {
        ...baseParams,
        map_label: titleTrim.slice(0, 120),
      },
      classification_confidence: confMid,
    };
  }

  // MMA / boxing: method of victory, distance
  if (
    /\bwill the fight be won by\b/i.test(text) ||
    /\bfight to go the distance\b/i.test(text) ||
    /\bfight end before round\b/i.test(text)
  ) {
    return {
      market_template: "sports-fight-method",
      template_params: { ...baseParams, bout: String(row.title || "").slice(0, 160) },
      classification_confidence: confMid,
    };
  }

  // Motorsport: grid / lap / podium (F1-style)
  if (/\bgrand prix\b/i.test(text) && /\b(top\s+\d+\s+finishers|podium finishers|fastest lap)\b/i.test(text)) {
    return {
      market_template: "sports-race-finish",
      template_params: {
        ...baseParams,
        race_descriptor: String(row.title || "").slice(0, 180),
      },
      classification_confidence: confMid,
    };
  }

  // Soccer / football: draw result
  if (/\bwill the match end in a draw\b/i.test(text)) {
    return {
      market_template: "sports-match-draw",
      template_params: { ...baseParams },
      classification_confidence: confMid,
    };
  }

  // Series / championship
  if (/\b(win the|wins the)\b.*\b(series|championship|cup|conference)\b/i.test(text) || /\bstanley cup|world series|nba finals|super bowl champion\b/i.test(text)) {
    const teamM = text.match(/\b(will )?([A-Z][a-zA-Z .'-]+)\b (win|wins)/);
    return {
      market_template: "sports-series",
      template_params: {
        sport: sport || "unknown",
        team: teamM ? teamM[2].trim() : null,
        series_name: null,
      },
      classification_confidence: confMid,
    };
  }

  const bucket = classifyMarketTypeBucket(row.title || "");
  if (bucket && SPORTS_BUCKET_TO_TEMPLATE[bucket]) {
    return {
      market_template: SPORTS_BUCKET_TO_TEMPLATE[bucket],
      template_params: baseParams,
      classification_confidence: game_date && sport && sport !== "unknown" ? confHigh : confMid,
    };
  }

  // "Who will win" without bucket
  if (/^\s*who will win\b/i.test(String(row.title || "").trim()) || /\bwho wins\b/i.test(text)) {
    return {
      market_template: "sports-matchup-winner",
      template_params: { sport: sport || "unknown", event_name: String(row.title || "").slice(0, 200) },
      classification_confidence: confMid,
    };
  }

  // Season / game yes-no
  if (/\bwill\b.*\b(this season|in the game|tonight|today)\b/i.test(text)) {
    return {
      market_template: "sports-yes-no",
      template_params: { ...baseParams, event_description: String(row.title || "").slice(0, 200) },
      classification_confidence: confLow,
    };
  }

  // Matchup moneyline fallback
  if ((se.isMatchup || (home_team && away_team)) && game_date) {
    return {
      market_template: "sports-moneyline",
      template_params: baseParams,
      classification_confidence: confLow,
    };
  }

  // Esports / props: odd/even map or round totals
  if (/\bodd\/even\b/i.test(text) && /\b(map|game)\s*\d*\s*:/i.test(text)) {
    return {
      market_template: "sports-yes-no",
      template_params: {
        ...baseParams,
        event_description: String(row.title || "").slice(0, 200),
      },
      classification_confidence: confLow,
    };
  }

  return { market_template: null, template_params: {}, classification_confidence: null };
}

function classifyPolitics(row, text) {
  const confH = 0.9;
  const confM = 0.8;
  const confL = 0.72;
  const yearM = text.match(/\b(202[4-9]|203\d)\b/);
  const year = yearM ? yearM[1] : null;
  const catSlug = String(row.category || "").toLowerCase();

  // Coarse signals from pmci category slugs (often more reliable than title alone)
  if (/nominee/.test(catSlug) && /(presidential|primary|democrat|republican)/.test(catSlug)) {
    let party = null;
    if (/democrat/.test(catSlug)) party = "democratic";
    if (/republican/.test(catSlug)) party = "republican";
    return {
      market_template: "nomination",
      template_params: { person: null, party, office: "president", year: year || (catSlug.match(/\b(202\d)\b/)?.[1] ?? null) },
      classification_confidence: 0.93,
    };
  }
  if (/(house|senate|governor|mayor).*(election|winner)|election.*winner/.test(catSlug)) {
    let office = "unknown";
    if (/senate/.test(catSlug)) office = "senate";
    if (/house/.test(catSlug)) office = "house";
    if (/governor/.test(catSlug)) office = "governor";
    if (/mayor/.test(catSlug)) office = "mayor";
    return {
      market_template: "election-winner",
      template_params: { office, jurisdiction: null, year: year || catSlug.match(/\b(202\d)\b/)?.[1] || null },
      classification_confidence: 0.91,
    };
  }

  if (/\b(nominee|nomination|presidential primary|democratic primary|republican primary)\b/i.test(text)) {
    const personM = text.match(/\b(will )?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b.*\b(nominee|nomination)\b/i);
    return {
      market_template: "nomination",
      template_params: {
        person: personM ? personM[2] : null,
        party: /\bdemocratic\b/i.test(text) ? "democratic" : /\brepublican\b/i.test(text) ? "republican" : null,
        office: /\bpresident\b/i.test(text) ? "president" : null,
        year,
      },
      classification_confidence: confM,
    };
  }

  if (/\bconfirmed\b.*\b(as|to)\b|\bconfirmation vote\b|\bwill .* be confirmed\b/i.test(text)) {
    return {
      market_template: "confirmation",
      template_params: { person: null, role: null },
      classification_confidence: confL,
    };
  }

  if (/\bcontrol of (the )?(house|senate)\b|\bwhich party.*\b(house|senate)\b|\bhouse control|senate control\b/i.test(text)) {
    return {
      market_template: "party-control",
      template_params: { chamber_or_seat: /\bsenate\b/i.test(text) ? "senate" : "house", year },
      classification_confidence: year ? confH : confM,
    };
  }

  if (/\b(will|does)\b.*\b(sign|veto|issue an executive order|pardon)\b/i.test(text) && /\b(president|trump|biden)\b/i.test(text)) {
    return {
      market_template: "presidential-action",
      template_params: { person: null, action: null, deadline: extractDate(text) },
      classification_confidence: confL,
    };
  }

  if (/\bwill\b.*\b(bill|act|law|policy)\b.*\b(pass|fail|signed)\b/i.test(text)) {
    return {
      market_template: "policy-binary",
      template_params: { policy: null, deadline: extractDate(text) },
      classification_confidence: confL,
    };
  }

  if (
    /\bwho will win\b.*\b(president|senate|governor|mayor|house)\b/i.test(text) ||
    /\bwill\b.*\bwin\b.*\b(election|race|presidency)\b/i.test(text) ||
    /\bgovernor\b.*\b(202[4-9])\b/i.test(text)
  ) {
    let office = "unknown";
    if (/\bpresident\b/i.test(text)) office = "president";
    if (/\bsenate\b/i.test(text)) office = "senate";
    if (/\bgovernor\b/i.test(text)) office = "governor";
    if (/\bhouse\b/i.test(text)) office = "house";
    return {
      market_template: "election-winner",
      template_params: { office, jurisdiction: null, year },
      classification_confidence: year ? confH : confM,
    };
  }

  return { market_template: null, template_params: {}, classification_confidence: null };
}

/**
 * Full-row classification for CSV export.
 */
export function classifyVocabularyTemplate(row) {
  const bucket = effectiveCategoryBucket(row);
  const text = combinedText(row);

  if (bucket === "crypto") {
    return classifyCrypto(row, text);
  }
  if (bucket === "economics") {
    return classifyEconomics(row, text);
  }
  if (bucket === "sports") {
    return classifySports(row, text);
  }
  if (bucket === "politics") {
    return classifyPolitics(row, text);
  }

  return { market_template: null, template_params: {}, classification_confidence: null };
}

/**
 * Normalize title for clustering unclassified rows.
 */
export function nullPatternKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, "#DATE#")
    .replace(/\d+/g, "#")
    .replace(/\$[\d,.]+/g, "$#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);
}
