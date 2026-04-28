import test from "node:test";
import assert from "node:assert/strict";

import {
  ancestorHashesFromTip,
  findLcaHash,
  oldMainAfterLca,
  processForkChoice,
  promoteFinalRows,
  DEFAULT_CONFIRMATION_DEPTH,
} from "../../lib/poly-indexer/reorg.mjs";

/** @returns {Map<string, import("../../lib/poly-indexer/reorg.mjs").BlockHeader>} */
function fromChain(headers) {
  const m = new Map();
  for (const h of headers) {
    m.set(h.hash, h);
  }
  return m;
}

function H(n, tag, parentHash) {
  return {
    blockNumber: n,
    hash: `0xb${String(n).padStart(62, `${tag}`)}`,
    parentHash,
  };
}

test("linear append yields empty orphan trail (tip extends prior)", () => {
  const g = H(0, "g", `0x${"a".repeat(64)}`);
  const b1 = H(1, "1", g.hash);
  const b2 = H(2, "2", b1.hash);
  const hdr = fromChain([g, b1, b2]);
  const lca = findLcaHash(hdr, b1.hash, b2.hash);
  assert.equal(lca, b1.hash);
  const dropped = oldMainAfterLca(hdr, b1.hash, lca);
  assert.deepEqual(dropped, []);
});

test("simple one-block reorg — alternate tip at same height", () => {
  const gen = `0xg${"0".repeat(63)}`;
  const g = H(0, "g", gen);
  const a1 = H(1, "a", g.hash);
  const oldTip = H(2, "o", a1.hash);
  const nuTip = H(2, "n", a1.hash);
  const hdr = fromChain([g, a1, oldTip, nuTip]);
  const lca = findLcaHash(hdr, oldTip.hash, nuTip.hash);
  assert.equal(lca, a1.hash);
  const dropped = oldMainAfterLca(hdr, oldTip.hash, lca);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].hash, oldTip.hash);
});

test("five-block orphan trail after deep fork", () => {
  const gen = `0xg${"0".repeat(63)}`;
  const chain = [];
  chain[0] = H(0, "0", gen);
  for (let n = 1; n <= 5; n++) {
    chain[n] = H(n, "m", chain[n - 1].hash);
  }
  const common = chain[5];
  const forkA = [];
  let p = common.hash;
  for (let n = 6; n <= 10; n++) {
    const b = H(n, "A", p);
    forkA.push(b);
    p = b.hash;
  }
  const forkB = [];
  p = common.hash;
  for (let n = 6; n <= 10; n++) {
    const b = H(n, "B", p);
    forkB.push(b);
    p = b.hash;
  }
  const all = [...chain, ...forkA, ...forkB];
  const hdr = fromChain(all);
  const oldTip = forkA[4];
  const newTip = forkB[4];
  assert.notEqual(oldTip.hash, newTip.hash);
  const lca = findLcaHash(hdr, oldTip.hash, newTip.hash);
  assert.equal(lca, common.hash);
  const dropped = oldMainAfterLca(hdr, oldTip.hash, lca);
  assert.equal(dropped.length, 5);
});

test("processForkChoice — soft-delete rows on orphan branch", () => {
  const gen = `0xg${"0".repeat(63)}`;
  const g = H(0, "g", gen);
  const a1 = H(1, "a", g.hash);
  const oldTip = H(2, "o", a1.hash);
  const nuTip = H(2, "n", a1.hash);
  const hdr = fromChain([g, a1, oldTip, nuTip]);
  const rows = [
    {
      block_number: oldTip.blockNumber,
      block_hash: oldTip.hash,
      final: false,
      id: 1,
    },
  ];
  const r = processForkChoice({
    headerByHash: hdr,
    oldTipHash: oldTip.hash,
    newTipHash: nuTip.hash,
    rows,
    now: new Date("2026-04-28T12:00:00Z"),
  });
  assert.equal(r.panic, false);
  assert.equal(r.orphanUpdates.length, 1);
  assert.ok(r.orphanUpdates[0].orphaned_at);
});

test("final-row reorg triggers panic", () => {
  const gen = `0xg${"0".repeat(63)}`;
  const g = H(0, "g", gen);
  const a1 = H(1, "a", g.hash);
  const oldTip = H(2, "o", a1.hash);
  const nuTip = H(2, "n", a1.hash);
  const hdr = fromChain([g, a1, oldTip, nuTip]);
  const rows = [
    {
      block_number: oldTip.blockNumber,
      block_hash: oldTip.hash,
      final: true,
      id: 1,
    },
  ];
  const r = processForkChoice({
    headerByHash: hdr,
    oldTipHash: oldTip.hash,
    newTipHash: nuTip.hash,
    rows,
  });
  assert.equal(r.panic, true);
  assert.ok(r.panicReason);
});

test("promoteFinalRows respects confirmation depth", () => {
  const rows = [{ block_number: 100, block_hash: "0x1", final: false, id: 1 }];
  const bn = 100;
  const depth = DEFAULT_CONFIRMATION_DEPTH;
  const tooSoon = promoteFinalRows(rows, bn + depth - 1, depth);
  assert.equal(tooSoon[0].final, false);
  const ok = promoteFinalRows(rows, bn + depth, depth);
  assert.equal(ok[0].final, true);
});

test("ancestorHashesFromTip includes full walk", () => {
  const gen = `0xg${"0".repeat(63)}`;
  const g = H(0, "g", gen);
  const a1 = H(1, "a", g.hash);
  const tip = H(2, "t", a1.hash);
  const hdr = fromChain([g, a1, tip]);
  const s = ancestorHashesFromTip(hdr, tip.hash);
  assert.ok(s.has(tip.hash));
  assert.ok(s.has(g.hash));
});
