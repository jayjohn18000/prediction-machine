import test from "node:test";
import assert from "node:assert/strict";
import {
  unixMs5s,
  formatClientOrderId,
  nextClientOrderId,
  clearClientOrderIdBucketMemo,
  randomHex4,
  tickerSegmentForClientOrderId,
} from "../../lib/mm/client-order-id.mjs";

test("unixMs5s rounds down to 5s boundary", () => {
  assert.equal(unixMs5s(12_346), 10_000);
  assert.equal(unixMs5s(4999), 0);
});

test("formatClientOrderId matches R9 mm-<ticker>-<side>-<unix_ms_5s>-<rand4>", () => {
  const clock = unixMs5s(99_987);
  const id = formatClientOrderId({ ticker: "KXTEST-FOO", side: "yes_buy", now: clock + 321 });
  const re = /^mm-(.+)-(yes_buy|yes_sell|no_buy|no_sell)-(\d+)-([0-9a-f]{4})$/;
  const m = re.exec(id);
  assert.ok(m, id);
  assert.equal(m[1], "KXTEST-FOO");
  assert.equal(Number(m[3]), unixMs5s(clock + 321));
});

test("tickerSegmentForClientOrderId replaces dots (Kalshi client_order_id rejects some dotted ids)", () => {
  assert.equal(tickerSegmentForClientOrderId("KXLCPIMAXYOY-27-P4.5"), "KXLCPIMAXYOY-27-P4_5");
});

test("formatClientOrderId emits no dots in wire id for decimal-strike tickers", () => {
  const clock = unixMs5s(100_000);
  const id = formatClientOrderId({ ticker: "KXLCPIMAXYOY-27-P4.5", side: "yes_buy", now: clock + 1 });
  assert.equal(id.includes("."), false);
  assert.ok(id.startsWith("mm-KXLCPIMAXYOY-27-P4_5-yes_buy-"), id);
});

test("nextClientOrderId reuses bucket on retry within 5s (R9 idempotent)", () => {
  clearClientOrderIdBucketMemo();
  const now = 50_432;
  const a = nextClientOrderId({ ticker: "T", side: "no_sell", now, reuseRetry: false });
  const b = nextClientOrderId({ ticker: "T", side: "no_sell", now: now + 100, reuseRetry: true });
  assert.equal(a, b);
  const c = nextClientOrderId({ ticker: "T", side: "no_sell", now: now + 6000, reuseRetry: true });
  assert.notEqual(a, c);
});

test("randomHex4 is lowercase hex length 4", () => {
  assert.match(randomHex4(), /^[0-9a-f]{4}$/);
});
