/**
 * Unit tests for /events-based MM rotator candidate discovery.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROTATOR_SERIES_ALLOWLIST_DEFAULT,
  resolveRotatorSeriesAllowlist,
  resolveRotatorBackend,
  flattenAllowlistedNestedMarkets,
  marketNeedsIndividualPriceFetch,
  mergeMarketDetailQuote,
  fetchOpenMarketsViaEvents,
} from "../../scripts/mm/rotate-demo-tickers.mjs";

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("flattenAllowlistedNestedMarkets keeps allowlisted series only", () => {
  const allow = new Set(["KXMLBGAME"]);
  const events = [
    {
      series_ticker: "KXMVEEXOTIC",
      event_ticker: "P1",
      markets: [{ ticker: "KXMVE-JUNK-1", yes_bid_dollars: "0.5", yes_ask_dollars: "0.6" }],
    },
    {
      series_ticker: "KXPRESNOMD",
      event_ticker: "P2",
      markets: [{ ticker: "PRES-1", yes_bid_dollars: "0.4", yes_ask_dollars: "0.55" }],
    },
    {
      series_ticker: "KXMLBGAME",
      event_ticker: "MLB-EV",
      markets: [
        {
          ticker: "KXMLBGAME-26MAY06-BOS-BOS",
          yes_bid_dollars: "0.45",
          yes_ask_dollars: "0.55",
          close_time: "2030-01-01T00:00:00Z",
        },
      ],
    },
  ];
  const out = flattenAllowlistedNestedMarkets(events, allow);
  assert.equal(out.length, 1);
  assert.equal(out[0].ticker, "KXMLBGAME-26MAY06-BOS-BOS");
  assert.equal(out[0].event_ticker, "MLB-EV");
});

test("marketNeedsIndividualPriceFetch when nested bid/ask missing or zero", () => {
  assert.equal(marketNeedsIndividualPriceFetch({}), true);
  assert.equal(
    marketNeedsIndividualPriceFetch({ yes_bid_dollars: "0", yes_ask_dollars: "0" }),
    true,
  );
  assert.equal(
    marketNeedsIndividualPriceFetch({ yes_bid_dollars: "0.45", yes_ask_dollars: "0.55" }),
    false,
  );
});

test("mergeMarketDetailQuote overlays detail fields", () => {
  const target = { ticker: "X", yes_bid_dollars: "0", yes_ask_dollars: "0" };
  mergeMarketDetailQuote(target, {
    yes_bid_dollars: "0.41",
    yes_ask_dollars: "0.47",
    volume_24h_fp: "1234",
  });
  assert.equal(target.yes_bid_dollars, "0.41");
  assert.equal(target.yes_ask_dollars, "0.47");
  assert.equal(target.volume_24h_fp, "1234");
});

test("fetchOpenMarketsViaEvents: empty events → empty candidates (no throw)", async () => {
  const fetchFn = async () => jsonResponse({ events: [], cursor: null });
  const rows = await fetchOpenMarketsViaEvents(
    "https://api.example/trade-api/v2",
    { info() {}, warn() {} },
    { fetch: fetchFn },
  );
  assert.deepEqual(rows, []);
});

test("fetchOpenMarketsViaEvents: per-ticker quote when nested prices unusable", async () => {
  const urls = [];
  const fetchFn = async (/** @type {string} */ url) => {
    urls.push(url);
    if (url.includes("/events")) {
      return jsonResponse({
        events: [
          {
            series_ticker: "KXMLBGAME",
            event_ticker: "EV1",
            markets: [
              {
                ticker: "KXMLBGAME-NESTED-1",
                yes_bid_dollars: "0",
                yes_ask_dollars: "0",
                volume_24h_fp: "0",
                close_time: "2030-06-01T12:00:00Z",
                open_time: "2020-01-01T12:00:00Z",
              },
            ],
          },
        ],
        cursor: null,
      });
    }
    if (url.includes("/markets/KXMLBGAME-NESTED-1")) {
      return jsonResponse({
        market: {
          ticker: "KXMLBGAME-NESTED-1",
          yes_bid_dollars: "0.42",
          yes_ask_dollars: "0.48",
          volume_24h_fp: "999",
          close_time: "2030-06-01T12:00:00Z",
          open_time: "2020-01-01T12:00:00Z",
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const rows = await fetchOpenMarketsViaEvents(
    "https://api.example/trade-api/v2",
    { info() {}, warn() {} },
    { fetch: fetchFn },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].yes_bid_dollars, "0.42");
  assert.equal(rows[0].yes_ask_dollars, "0.48");
  assert.ok(urls.some((u) => u.includes("/markets/KXMLBGAME-NESTED-1")));
});

test("fetchOpenMarketsViaEvents: respects MM_ROTATOR_PRICE_FETCH_CONCURRENCY", async (t) => {
  t.after(() => {
    delete process.env.MM_ROTATOR_PRICE_FETCH_CONCURRENCY;
    delete process.env.MM_ROTATOR_INTER_PAGE_DELAY_MS;
  });
  process.env.MM_ROTATOR_PRICE_FETCH_CONCURRENCY = "2";
  process.env.MM_ROTATOR_INTER_PAGE_DELAY_MS = "0";

  let inFlight = 0;
  let maxConcurrent = 0;
  const n = 12;
  const fetchFn = async (/** @type {string} */ url) => {
    if (url.includes("/events")) {
      const markets = Array.from({ length: n }, (_, i) => ({
        ticker: `KXMLBGAME-PAR-${i}`,
        yes_bid_dollars: "0",
        yes_ask_dollars: "0",
        close_time: "2030-06-01T12:00:00Z",
        open_time: "2020-01-01T12:00:00Z",
      }));
      return jsonResponse({
        events: [{ series_ticker: "KXMLBGAME", event_ticker: "EVC", markets }],
        cursor: null,
      });
    }
    if (url.includes("/markets/KXMLBGAME-PAR-")) {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      const path = new URL(url).pathname;
      const ticker = decodeURIComponent(path.split("/").pop() ?? "");
      return jsonResponse({
        market: {
          ticker,
          yes_bid_dollars: "0.4",
          yes_ask_dollars: "0.6",
          volume_24h_fp: "10",
          close_time: "2030-06-01T12:00:00Z",
          open_time: "2020-01-01T12:00:00Z",
        },
      });
    }
    return new Response("not found", { status: 404 });
  };

  await fetchOpenMarketsViaEvents(
    "https://api.example/trade-api/v2",
    { info() {}, warn() {} },
    { fetch: fetchFn },
  );
  assert.ok(maxConcurrent <= 2, `max concurrent was ${maxConcurrent}, expected ≤2`);
});

test("fetchOpenMarketsViaEvents: 429 on /events then success", async (t) => {
  const prevB = process.env.MM_ROTATOR_429_BACKOFF_BASE_MS;
  process.env.MM_ROTATOR_429_BACKOFF_BASE_MS = "5";
  t.after(() => {
    if (prevB === undefined) delete process.env.MM_ROTATOR_429_BACKOFF_BASE_MS;
    else process.env.MM_ROTATOR_429_BACKOFF_BASE_MS = prevB;
  });
  let eventCalls = 0;
  const fetchFn = async (/** @type {string} */ url) => {
    if (url.includes("/events")) {
      eventCalls += 1;
      if (eventCalls === 1) return new Response("slow down", { status: 429 });
      return jsonResponse({
        events: [
          {
            series_ticker: "KXMLBGAME",
            event_ticker: "EV429",
            markets: [
              {
                ticker: "KXMLBGAME-429-R",
                yes_bid_dollars: "0.48",
                yes_ask_dollars: "0.52",
                close_time: "2030-06-01T12:00:00Z",
                open_time: "2020-01-01T12:00:00Z",
              },
            ],
          },
        ],
        cursor: null,
      });
    }
    return new Response("not found", { status: 404 });
  };
  const rows = await fetchOpenMarketsViaEvents(
    "https://api.example/trade-api/v2",
    { info() {}, warn() {} },
    { fetch: fetchFn },
  );
  assert.equal(eventCalls, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, "KXMLBGAME-429-R");
});

test("fetchOpenMarketsViaEvents: 429 on market detail then success", async (t) => {
  const prevB = process.env.MM_ROTATOR_429_BACKOFF_BASE_MS;
  process.env.MM_ROTATOR_429_BACKOFF_BASE_MS = "5";
  t.after(() => {
    if (prevB === undefined) delete process.env.MM_ROTATOR_429_BACKOFF_BASE_MS;
    else process.env.MM_ROTATOR_429_BACKOFF_BASE_MS = prevB;
  });
  let detailCalls = 0;
  const fetchFn = async (/** @type {string} */ url) => {
    if (url.includes("/events")) {
      return jsonResponse({
        events: [
          {
            series_ticker: "KXMLBGAME",
            event_ticker: "EVD",
            markets: [
              {
                ticker: "KXMLBGAME-DETAIL-429",
                yes_bid_dollars: "0",
                yes_ask_dollars: "0",
                close_time: "2030-06-01T12:00:00Z",
                open_time: "2020-01-01T12:00:00Z",
              },
            ],
          },
        ],
        cursor: null,
      });
    }
    if (url.includes("/markets/KXMLBGAME-DETAIL-429")) {
      detailCalls += 1;
      if (detailCalls === 1) return new Response("rate limited", { status: 429 });
      return jsonResponse({
        market: {
          ticker: "KXMLBGAME-DETAIL-429",
          yes_bid_dollars: "0.43",
          yes_ask_dollars: "0.57",
          volume_24h_fp: "50",
          close_time: "2030-06-01T12:00:00Z",
          open_time: "2020-01-01T12:00:00Z",
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const rows = await fetchOpenMarketsViaEvents(
    "https://api.example/trade-api/v2",
    { info() {}, warn() {} },
    { fetch: fetchFn },
  );
  assert.ok(detailCalls >= 2);
  assert.equal(rows[0].yes_bid_dollars, "0.43");
});

test("MM_ROTATOR_SERIES_ALLOWLIST env overrides defaults", (t) => {
  t.after(() => {
    delete process.env.MM_ROTATOR_SERIES_ALLOWLIST;
  });
  process.env.MM_ROTATOR_SERIES_ALLOWLIST = "AAA,bbb";
  assert.deepEqual(resolveRotatorSeriesAllowlist(), ["AAA", "BBB"]);
});

test("resolveRotatorBackend defaults to events; markets when set", (t) => {
  t.after(() => {
    delete process.env.MM_ROTATOR_BACKEND;
  });
  delete process.env.MM_ROTATOR_BACKEND;
  assert.equal(resolveRotatorBackend(), "events");
  process.env.MM_ROTATOR_BACKEND = "markets";
  assert.equal(resolveRotatorBackend(), "markets");
});

test("ROTATOR_SERIES_ALLOWLIST_DEFAULT includes core single-game prefixes", () => {
  assert.ok(ROTATOR_SERIES_ALLOWLIST_DEFAULT.includes("KXMLBGAME"));
  assert.ok(!ROTATOR_SERIES_ALLOWLIST_DEFAULT.includes("KXMVEGAME"));
});
