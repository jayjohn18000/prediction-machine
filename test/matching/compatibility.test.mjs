import test from "node:test";
import assert from "node:assert/strict";
import {
  sportsMarketTypePairAllowed,
  cryptoPairPrefilter,
  cryptoAssetBucket,
} from "../../lib/matching/compatibility.mjs";

test("sportsMarketTypePairAllowed rejects mismatched buckets", () => {
  const r = sportsMarketTypePairAllowed("Team A vs B — totals 48.5", "Team A vs B — moneyline winner");
  assert.equal(r.ok, false);
  assert.match(r.reason, /^market_type_mismatch:/);
});

test("cryptoPairPrefilter requires same asset", () => {
  const k = { title: "Will Bitcoin reach 100k", provider_market_ref: "KXBTC-1" };
  const p = { title: "Ethereum above 3000", provider_market_ref: "x" };
  const bad = cryptoPairPrefilter(k, p);
  assert.equal(bad.ok, false);
  const p2 = { title: "Bitcoin spot ETF", provider_market_ref: "y" };
  const good = cryptoPairPrefilter(k, p2);
  assert.equal(good.ok, true);
});

test("cryptoAssetBucket", () => {
  assert.equal(cryptoAssetBucket("BTC above 90k"), "btc");
  assert.equal(cryptoAssetBucket("ETH staking"), "eth");
});
