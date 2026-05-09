import test from "node:test";
import assert from "node:assert/strict";
import { selectMarketsForRotation } from "../../../scripts/mm/rotate-demo-tickers.mjs";

test("rodlaf bug 5: MVE / scalar blocklist ∩ rotator selections is empty", async () => {
  const farClose = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const markets = [
    {
      ticker: "KXMVE-TEST-LEGACY",
      event_ticker: "KXEV1",
      close_time: farClose,
      yes_bid_dollars: "0.45",
      yes_ask_dollars: "0.46",
      volume_24h_fp: "9000",
    },
    {
      ticker: "KXGOVTEST-OK",
      event_ticker: "KXEV2",
      close_time: farClose,
      yes_bid_dollars: "0.45",
      yes_ask_dollars: "0.46",
      volume_24h_fp: "9000",
    },
    {
      ticker: "KXLCPIMAXYOY-27-P4.5",
      event_ticker: "KXEV3",
      close_time: farClose,
      yes_bid_dollars: "0.45",
      yes_ask_dollars: "0.46",
      volume_24h_fp: "9000",
    },
  ];
  const blocked = new Set(["KXLCPIMAXYOY-27-P4.5"]);
  const { selections } = await selectMarketsForRotation(markets, {
    blockedTickers: blocked,
    minCloseHours: 1,
    target: 10,
    skipProdCrossCheck: true,
    runMode: "prod",
  });
  const picked = new Set(selections.map((s) => s.ticker));
  for (const t of picked) {
    assert.ok(!t.startsWith("KXMVE"), `MVE leak ${t}`);
    assert.ok(!blocked.has(t), `blocklist leak ${t}`);
  }
});
