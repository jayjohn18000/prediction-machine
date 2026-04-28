import test from "node:test";
import assert from "node:assert/strict";

import { jsonRpc, getBlockReceipts } from "../../lib/poly-indexer/clients/polygon-rpc.mjs";

test("getBlockReceipts — smoke (live Polygon RPC)", async (t) => {
  if (process.env.SKIP_LIVE_RPC === "1") {
    t.skip(`SKIP_LIVE_RPC=1`);
    return;
  }
  /** @returns {bigint} */
  async function latestBlockBn() {
    const hex = await jsonRpc("eth_blockNumber", [], { timeoutMs: 20_000, retries: 2 });
    return BigInt(hex);
  }
  try {
    const head = await latestBlockBn();
    const target = head > 128n ? head - 64n : head;
    const receipts = await getBlockReceipts(target);
    assert.ok(Array.isArray(receipts));
    assert.ok(receipts.length > 0, "expected eth_getBlockReceipts to return non-empty receipts for a recent block");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/method.*not\s+found|does not exist|not available|not supported/i.test(msg)) {
      t.skip(`RPC endpoint missing eth_getBlockReceipts: ${msg}`);
      return;
    }
    throw e;
  }
});
