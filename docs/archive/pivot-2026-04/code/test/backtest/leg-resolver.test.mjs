import test from "node:test";
import assert from "node:assert/strict";
import { resolveLeg } from "../../lib/backtest/leg-resolver.mjs";

const kalshiMarket = { provider: "kalshi", provider_market_ref: "KXMLB#PHI-NYY" };

function polyMarket(overrides = {}) {
  return {
    provider: "polymarket",
    provider_market_ref: "0xabc#Athletics",
    title: "Athletics vs Yankees",
    home_team: "Athletics",
    away_team: "Yankees",
    ...overrides,
  };
}

test("kalshi YES leg, winning_outcome 'yes' → won", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "yes", winningOutcome: "yes" }),
    "won",
  );
});

test("kalshi YES leg, winning_outcome 'no' → lost", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "yes", winningOutcome: "no" }),
    "lost",
  );
});

test("kalshi NO leg, winning_outcome 'yes' → lost", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "no", winningOutcome: "yes" }),
    "lost",
  );
});

test("kalshi NO leg, winning_outcome 'no' → won", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "no", winningOutcome: "no" }),
    "won",
  );
});

test("polymarket YES leg matching team name in outcome → won", () => {
  assert.equal(
    resolveLeg({
      market: polyMarket(),
      side: "yes",
      winningOutcome: "Athletics",
    }),
    "won",
  );
});

test("polymarket YES leg with opposing team → lost", () => {
  assert.equal(
    resolveLeg({
      market: polyMarket(),
      side: "yes",
      winningOutcome: "Yankees",
    }),
    "lost",
  );
});

test("polymarket NO leg with own-outcome winner → lost", () => {
  assert.equal(
    resolveLeg({
      market: polyMarket(),
      side: "no",
      winningOutcome: "Athletics",
    }),
    "lost",
  );
});

// --- Futures / championship / single-question markets (Polymarket returns "Yes"/"No" literals) ---
// Regression guard for family-3218-style bug: ref has no #outcome suffix,
// home_team/away_team are null, and winning_outcome is a canonical "Yes"/"No".

function polyFuturesMarket(overrides = {}) {
  return {
    provider: "polymarket",
    // Bare condition_id, no '#outcome' suffix — matches what's in pmci for futures.
    provider_market_ref: "0xf2a4a7765e2f05824fce5cd598c6c4a636a5aadc12607c05527b340f161fd2f9",
    title: "Will Bayern Munich win the 2025–26 Bundesliga?",
    home_team: null,
    away_team: null,
    ...overrides,
  };
}

test("polymarket futures YES leg, winning_outcome 'Yes' → won (regression: family 3218)", () => {
  assert.equal(
    resolveLeg({ market: polyFuturesMarket(), side: "yes", winningOutcome: "Yes" }),
    "won",
  );
});

test("polymarket futures NO leg, winning_outcome 'Yes' → lost (regression: family 3218)", () => {
  assert.equal(
    resolveLeg({ market: polyFuturesMarket(), side: "no", winningOutcome: "Yes" }),
    "lost",
  );
});

test("polymarket futures YES leg, winning_outcome 'No' → lost", () => {
  assert.equal(
    resolveLeg({ market: polyFuturesMarket(), side: "yes", winningOutcome: "No" }),
    "lost",
  );
});

test("polymarket futures NO leg, winning_outcome 'No' → won", () => {
  assert.equal(
    resolveLeg({ market: polyFuturesMarket(), side: "no", winningOutcome: "No" }),
    "won",
  );
});

test("polymarket futures accepts lowercase 'yes' (case-insensitive)", () => {
  assert.equal(
    resolveLeg({ market: polyFuturesMarket(), side: "yes", winningOutcome: "yes" }),
    "won",
  );
});

test("winningOutcome: null → void", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "yes", winningOutcome: null }),
    "void",
  );
});

test("winningOutcome: '' → void", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "yes", winningOutcome: "" }),
    "void",
  );
});

test("winningOutcome: 'unknown' → void", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "yes", winningOutcome: "unknown" }),
    "void",
  );
});

test("winningOutcome: 'UNKNOWN' (case insensitive) → void", () => {
  assert.equal(
    resolveLeg({ market: kalshiMarket, side: "yes", winningOutcome: "UNKNOWN" }),
    "void",
  );
});

test("market status 'voided' → void regardless of winningOutcome", () => {
  const m = { provider: "kalshi", status: "voided" };
  assert.equal(
    resolveLeg({ market: m, side: "yes", winningOutcome: "yes" }),
    "void",
  );
});

test("invalid side throws", () => {
  assert.throws(() =>
    resolveLeg({ market: kalshiMarket, side: "both", winningOutcome: "yes" }),
  );
});

test("unknown provider throws", () => {
  assert.throws(() =>
    resolveLeg({ market: { provider: "manifold" }, side: "yes", winningOutcome: "yes" }),
  );
});
