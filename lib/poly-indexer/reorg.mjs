/**
 * Reorg state machine for Polygon head/final watermarks.
 * Pure helpers: block graph is supplied by the caller (RPC fixture or live).
 */

/** @typedef {{ blockNumber: number, hash: string, parentHash: string }} BlockHeader */

/** Default confirmations before a row may be marked `final` (audit §3 P2). */
export const DEFAULT_CONFIRMATION_DEPTH = 64;

/**
 * @param {Map<string, BlockHeader>} headerByHash
 * @param {string} tipHash
 * @param {number} [maxSteps]
 * @returns {Set<string>}
 */
export function ancestorHashesFromTip(headerByHash, tipHash, maxSteps = 1_000_000) {
  const out = new Set();
  let h = tipHash;
  for (let i = 0; i < maxSteps && h; i++) {
    const b = headerByHash.get(h);
    if (!b) break;
    out.add(b.hash);
    h = b.parentHash;
  }
  return out;
}

/**
 * Walk from new tip backward until a hash appears on the old main chain.
 * @param {Map<string, BlockHeader>} headerByHash
 * @param {string} oldTipHash
 * @param {string} newTipHash
 * @returns {string} LCA block hash
 */
export function findLcaHash(headerByHash, oldTipHash, newTipHash) {
  const oldAncestors = ancestorHashesFromTip(headerByHash, oldTipHash);
  let h = newTipHash;
  for (let i = 0; i < 1_000_000 && h; i++) {
    const b = headerByHash.get(h);
    if (!b) {
      throw new Error(`reorg: missing header for ${h}`);
    }
    if (oldAncestors.has(b.hash)) {
      return b.hash;
    }
    h = b.parentHash;
  }
  throw new Error("reorg: no common ancestor (disconnected graphs)");
}

/**
 * Blocks on the old main chain strictly after LCA (orphan trail), tip-first order.
 * @param {Map<string, BlockHeader>} headerByHash
 * @param {string} oldTipHash
 * @param {string} lcaHash
 * @returns {BlockHeader[]}
 */
export function oldMainAfterLca(headerByHash, oldTipHash, lcaHash) {
  const out = [];
  let h = oldTipHash;
  for (let i = 0; i < 1_000_000 && h && h !== lcaHash; i++) {
    const b = headerByHash.get(h);
    if (!b) {
      throw new Error(`reorg: missing header for ${h}`);
    }
    out.push(b);
    h = b.parentHash;
  }
  return out;
}

/**
 * @typedef {{ id?: string|number, block_number: number, block_hash: string, final: boolean, orphaned_at?: Date|null }} TradeRow
 */

/**
 * @param {TradeRow[]} rows
 * @param {BlockHeader[]} droppedBlocks
 * @param {Date} [now]
 * @returns {{ panic: boolean, reason?: string, orphanUpdates: TradeRow[] }}
 */
export function applyOrphanToRows(rows, droppedBlocks, now = new Date()) {
  const dropKey = new Set(
    droppedBlocks.map((b) => `${b.blockNumber}:${b.hash}`),
  );
  const finalHit = rows.some(
    (r) =>
      r.final &&
      dropKey.has(`${r.block_number}:${r.block_hash}`),
  );
  if (finalHit) {
    return {
      panic: true,
      reason: "final=true row would be orphaned (chain reorg past confirmation depth)",
      orphanUpdates: [],
    };
  }
  const orphanUpdates = rows
    .filter((r) =>
      dropKey.has(`${r.block_number}:${r.block_hash}`) && !r.orphaned_at,
    )
    .map((r) => ({ ...r, orphaned_at: now }));
  return { panic: false, orphanUpdates };
}

/**
 * Full fork-choice step: given old and new tips, compute dropped blocks on old main and row updates.
 * @param {{
 *   headerByHash: Map<string, BlockHeader>,
 *   oldTipHash: string,
 *   newTipHash: string,
 *   rows: TradeRow[],
 *   now?: Date,
 * }} p
 */
export function processForkChoice(p) {
  const lca = findLcaHash(p.headerByHash, p.oldTipHash, p.newTipHash);
  const dropped = oldMainAfterLca(
    p.headerByHash,
    p.oldTipHash,
    lca,
  );
  const { panic, reason, orphanUpdates } = applyOrphanToRows(
    p.rows,
    dropped,
    p.now,
  );
  return {
    lcaHash: lca,
    droppedBlocks: dropped,
    panic,
    panicReason: reason,
    orphanUpdates,
  };
}

/**
 * Mark rows final when `headNumber - block_number >= depth` (caller supplies head).
 * @param {TradeRow[]} rows
 * @param {bigint|number} headNumber
 * @param {number} [depth]
 * @returns {TradeRow[]}
 */
export function promoteFinalRows(rows, headNumber, depth = DEFAULT_CONFIRMATION_DEPTH) {
  const head = BigInt(headNumber);
  const d = BigInt(depth);
  return rows.map((r) => {
    const bn = BigInt(r.block_number);
    const eligible = head - bn >= d;
    if (r.final) return r;
    if (!eligible) return r;
    return { ...r, final: true };
  });
}
