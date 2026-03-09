/**
 * Pure similarity and scoring functions for PMCI matching pipeline.
 * No database access, no side effects, no domain constants (except PROXY_POLITICS_KEYWORDS
 * which is scoped to keywordOverlapScore).
 *
 * Extracted from proposal-engine.mjs (Step 5 decomposition).
 */

/** Shared politics keywords for proxy keyword_overlap_score (travel across venues). */
export const PROXY_POLITICS_KEYWORDS = new Set([
  'fed', 'chair', 'nominee', 'ban', 'tariff', 'meet', 'putin', 'zelenskyy', 'shutdown',
  'nuclear', 'deal', 'senate', 'house', 'election', 'presidential', 'democratic', 'republican',
  'primary', '2028', '2026', 'governor', 'congress', 'impeachment',
]);

export function tokenize(s) {
  if (!s || typeof s !== 'string') return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^-|-$/g, ''))
    .filter((t) => t.length > 1);
}

export function jaccard(a, b) {
  if (!a?.size && !b?.size) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function slugSimilarity(slugTokensA, slugTokensB) {
  return jaccard(new Set(slugTokensA), new Set(slugTokensB));
}

/** Keyword overlap for proxy: share of politics keywords present in either market that appear in both. */
export function keywordOverlapScore(tokensA, tokensB) {
  const setA = new Set((tokensA || []).filter((t) => PROXY_POLITICS_KEYWORDS.has(t)));
  const setB = new Set((tokensB || []).filter((t) => PROXY_POLITICS_KEYWORDS.has(t)));
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function computeEntityOverlap(tokensA, tokensB) {
  const a = new Set((tokensA || []).filter((t) => t && t.length > 1));
  const b = new Set((tokensB || []).filter((t) => t && t.length > 1));
  if (!a.size || !b.size) return null;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  if (inter === 0) return 0;
  const minSize = Math.min(a.size, b.size);
  if (inter === minSize) return 1;
  return 0.5;
}

export function normalizeOutcomeName(name) {
  return String(name || '').trim().toLowerCase();
}

export function parseVectorColumn(v) {
  if (!v) return null;
  if (Array.isArray(v)) {
    return v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  }
  const s = String(v).trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const inner = s.slice(1, -1);
  if (!inner) return null;
  const parts = inner.split(',').map((p) => Number(p.trim()));
  const nums = parts.filter((x) => Number.isFinite(x));
  return nums.length ? nums : null;
}

export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB)) return null;
  const n = Math.min(vecA.length, vecB.length);
  if (!n) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    const a = Number(vecA[i]);
    const b = Number(vecB[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Equivalent: high entity + high title/slug + high embedding cosine. Proxy: less on slug_similarity; add keyword_overlap, entity_strength, topic_match, time_window. */
export function scorePair(mA, mB, meta) {
  const {
    titleSim,
    slugSim,
    entityMatch,
    sharedTopics,
    keywordOverlapScore: kwScore = 0,
    entityStrength = entityMatch ? 1 : 0,
    topicMatchBonus = 0,
    timeWindowBonus = 0,
    embeddingSim = null,
  } = meta;
  const entityScore = entityMatch ? 1 : 0;
  const embScore = embeddingSim != null ? embeddingSim : 0;
  // Phase 2 weighting: bring embeddings into the core equivalent score.
  const equiv = 0.25 * titleSim + 0.20 * slugSim + 0.25 * entityScore + 0.30 * embScore;
  const equivConf = Math.min(1, equiv + (entityMatch ? 0.15 : 0) + (titleSim > 0.5 ? 0.1 : 0));
  // Proxy: rely less on slug; add topic-signature features so cross-venue pairs can clear threshold
  let proxyConf = equivConf * 0.75 + kwScore * 0.15 + entityStrength * 0.1 + topicMatchBonus + timeWindowBonus;
  if (sharedTopics && !entityMatch) proxyConf = Math.min(0.96, proxyConf + 0.1);
  return {
    equivalent_confidence: Math.round(equivConf * 10000) / 10000,
    proxy_confidence: Math.round(Math.min(0.97, proxyConf) * 10000) / 10000,
  };
}

/**
 * Exact maximum-weight bipartite matching (DP over bitmasks).
 * Good fit for block-local candidate sets (small/medium) and enforces one-to-one links.
 */
export function maxWeightBipartite(leftNodes, rightNodes, edges, maxRightForExact = 14) {
  if (!leftNodes.length || !rightNodes.length || !edges.length) return [];
  const rightIndex = new Map(rightNodes.map((id, idx) => [id, idx]));
  const leftOrder = [...leftNodes];
  const leftIndex = new Map(leftOrder.map((id, idx) => [id, idx]));

  // If right side is large, keep only top rights by max incoming edge to bound DP.
  if (rightNodes.length > maxRightForExact) {
    const rightBest = new Map();
    for (const e of edges) {
      const prev = rightBest.get(e.rightId) ?? -Infinity;
      if (e.weight > prev) rightBest.set(e.rightId, e.weight);
    }
    const topRights = [...rightBest.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxRightForExact)
      .map(([id]) => id);
    return maxWeightBipartite(leftNodes, topRights, edges.filter((e) => topRights.includes(e.rightId)), maxRightForExact);
  }

  const nL = leftOrder.length;
  const nR = rightNodes.length;
  const edgeByLeftRight = new Map();
  for (const e of edges) {
    const li = leftIndex.get(e.leftId) ?? -1;
    const ri = rightIndex.get(e.rightId);
    if (li < 0 || ri == null) continue;
    const key = `${li}:${ri}`;
    const prev = edgeByLeftRight.get(key);
    if (!prev || e.weight > prev.weight) edgeByLeftRight.set(key, e);
  }

  const memo = new Map();
  const take = new Map();
  function solve(i, mask) {
    if (i >= nL) return 0;
    const key = `${i}|${mask}`;
    if (memo.has(key)) return memo.get(key);

    let best = solve(i + 1, mask); // skip this left node
    let bestChoice = null;

    for (let r = 0; r < nR; r++) {
      if (mask & (1 << r)) continue;
      const e = edgeByLeftRight.get(`${i}:${r}`);
      if (!e) continue;
      const val = e.weight + solve(i + 1, mask | (1 << r));
      if (val > best) {
        best = val;
        bestChoice = { r, e };
      }
    }

    memo.set(key, best);
    if (bestChoice) take.set(key, bestChoice);
    return best;
  }

  solve(0, 0);
  const chosen = [];
  let i = 0;
  let mask = 0;
  while (i < nL) {
    const key = `${i}|${mask}`;
    const choice = take.get(key);
    if (!choice) {
      i += 1;
      continue;
    }
    chosen.push(choice.e);
    mask |= 1 << choice.r;
    i += 1;
  }
  return chosen;
}
