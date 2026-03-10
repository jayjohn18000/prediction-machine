export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function typeFactor(rel) {
  switch (rel) {
    case "identical":
    case "equivalent":
      return 1.0;
    case "proxy":
      return 0.5;
    case "correlated":
      return 0.25;
    default:
      return 0.25;
  }
}

export function computeConsensus(links, latestByMarketId) {
  let num = 0;
  let den = 0;
  for (const l of links) {
    if (l.status !== "active") continue;
    const snap = latestByMarketId.get(l.provider_market_id);
    if (!snap || snap.price_yes == null) continue;
    const liquidity = snap.liquidity == null ? 1 : Number(snap.liquidity);
    const confidence = Number(l.confidence);
    const w = liquidity * confidence * typeFactor(l.relationship_type);
    num += w * Number(snap.price_yes);
    den += w;
  }
  return den <= 0 ? null : num / den;
}

export function computeDivergence(price, consensus) {
  if (price == null || consensus == null) return null;
  return Math.abs(Number(price) - Number(consensus));
}
