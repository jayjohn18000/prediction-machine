/**
 * Rule-based crypto template classifier (Phase E4).
 * @param {{ title?: string, provider_market_ref?: string, provider_id?: number, category?: string }} market
 * @returns {{ template: string, params: Record<string, unknown> } | null}
 */

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

function assetPrefix(asset) {
  return asset || "crypto";
}

/** YYYY-MM-DD or MM/DD/YYYY */
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

export function classifyTemplate(market) {
  const title = String(market?.title || "");
  const ref = String(market?.provider_market_ref || "");
  const combined = `${title} ${ref}`;
  const asset = detectAsset(combined);
  const ap = assetPrefix(asset);

  if (/\b(microstrategy|mstr|coinbase|blackrock|etf)\b/i.test(combined) && asset) {
    return {
      template: "crypto-corporate",
      params: { asset, company: /microstrategy|mstr/i.test(combined) ? "microstrategy" : "unknown" },
    };
  }

  if (/\b(which|or)\b.*\b(btc|eth|bitcoin|ethereum).*\b(ath|all[- ]time high)\b/i.test(combined)) {
    const assets = [];
    if (/\bbtc|bitcoin\b/i.test(combined)) assets.push("btc");
    if (/\beth|ethereum\b/i.test(combined)) assets.push("eth");
    return { template: "crypto-comparative", params: { assets: assets.length ? assets : ["btc", "eth"] } };
  }

  if (/\binterval\b|\d+\s*min(ute)?s?\b.*\b(up or down|up\/down)\b/i.test(combined) || /up or down\s*-\s*\d{1,2}:\d{2}/i.test(combined)) {
    const dt = extractDate(combined) || null;
    return {
      template: `${ap}-interval`,
      params: { asset: asset || "btc", datetime_start: dt, interval_minutes: 5 },
    };
  }

  if (/\ball[- ]time high\b|\bath\b|\bhit\s+\$?\s*[\d,]+.*\bby\b/i.test(combined) && asset) {
    const strike = extractStrike(combined);
    const deadline = extractDate(combined);
    return {
      template: `${ap}-milestone`,
      params: { asset, strike, deadline },
    };
  }

  if (/\bdip(s)?\s+to\s+\$/i.test(combined) && asset) {
    const strike = extractStrike(combined);
    const date = extractDate(combined);
    return { template: `${ap}-price-dip`, params: { asset, strike, date } };
  }

  if (
    (/\babove\b|\bbelow\b|\bover\b|\bunder\b/i.test(combined) && /\$/.test(combined)) ||
    /(above|below)\s+\$?\s*[\d,]+/i.test(combined)
  ) {
    if (asset) {
      const strike = extractStrike(combined);
      const date = extractDate(combined);
      let direction = null;
      if (/\babove\b|\bover\b|\bexceed/i.test(combined)) direction = "above";
      if (/\bbelow\b|\bunder\b/i.test(combined)) direction = "below";
      return {
        template: `${ap}-price-threshold`,
        params: { asset, date, strike, direction },
      };
    }
  }

  if (/\bup or down\b/i.test(combined) && asset) {
    const date = extractDate(combined);
    return { template: `${ap}-daily-direction`, params: { asset, date } };
  }

  if (/\b(price )?range\b|\bbetween\s+\$/i.test(combined) && asset) {
    const date = extractDate(combined);
    return { template: `${ap}-daily-range`, params: { asset, date } };
  }

  if (/\bprice\b.*\bon\b/i.test(combined) && asset && extractDate(combined)) {
    const date = extractDate(combined);
    return { template: `${ap}-daily-range`, params: { asset, date } };
  }

  if (asset) {
    const date = extractDate(combined);
    return { template: `${ap}-generic`, params: { asset, date } };
  }

  return null;
}
