import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreEventAttachment,
  scoreSportsAttachmentDetailed,
  isLinkerH2HTeamsBypassEnabled,
} from "../../lib/matching/event-matcher.mjs";
import { normalizeTeamName } from "../../lib/matching/sports-helpers.mjs";

// Save + restore env across tests.
function withEnv(overrides, fn) {
  const prev = { ...process.env };
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    // Restore fully — drop any keys the test added.
    for (const k of Object.keys(process.env)) {
      if (!(k in prev)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(prev)) {
      process.env[k] = v;
    }
  }
}

// Convenience builder: canonical_events row shape.
function eventRow(patch = {}) {
  return {
    category: "sports",
    sport: "mlb",
    event_date: "2026-04-24",
    participants: [
      { role: "away", name: "Milwaukee Brewers" },
      { role: "home", name: "Boston Red Sox" },
    ],
    ...patch,
  };
}

// Convenience builder: provider_markets row shape.
function marketRow(patch = {}) {
  return {
    category: "sports",
    sport: "mlb",
    home_team: "Boston Red Sox",
    away_team: "Milwaukee Brewers",
    game_date: "2026-04-24",
    title: "Milwaukee Brewers vs. Boston Red Sox",
    ...patch,
  };
}

// ─────────────────────────────────────────────────────────
// Bypass flag reader
// ─────────────────────────────────────────────────────────
test("isLinkerH2HTeamsBypassEnabled reads env truthy variants", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    assert.equal(isLinkerH2HTeamsBypassEnabled(), true);
  });
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "1" }, () => {
    assert.equal(isLinkerH2HTeamsBypassEnabled(), true);
  });
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "yes" }, () => {
    assert.equal(isLinkerH2HTeamsBypassEnabled(), true);
  });
});

test("isLinkerH2HTeamsBypassEnabled defaults to false", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: undefined }, () => {
    assert.equal(isLinkerH2HTeamsBypassEnabled(), false);
  });
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "false" }, () => {
    assert.equal(isLinkerH2HTeamsBypassEnabled(), false);
  });
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "" }, () => {
    assert.equal(isLinkerH2HTeamsBypassEnabled(), false);
  });
});

// ─────────────────────────────────────────────────────────
// Happy path regression: sport-equality exact-teams unchanged
// ─────────────────────────────────────────────────────────
test("happy path: exact teams + same date → 1.0 (no regression)", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "false" }, () => {
    const score = scoreEventAttachment(eventRow(), marketRow());
    assert.equal(score, 1.0);
  });
});

test("happy path: exact teams + 1 day delta → 0.92", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "false" }, () => {
    const score = scoreEventAttachment(
      eventRow({ event_date: "2026-04-24" }),
      marketRow({ game_date: "2026-04-25" }),
    );
    assert.equal(score, 0.92);
  });
});

test("happy path: fuzzy teams, same sport, same date → 0.9 under normal flow", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "false" }, () => {
    const score = scoreEventAttachment(
      eventRow(),
      marketRow({ home_team: "Red Sox", away_team: "Brewers" }),
    );
    // fuzzy (subset-substring) match → 0.9 at delta=0
    assert.equal(score, 0.9);
  });
});

// ─────────────────────────────────────────────────────────
// Bypass path: flag on + one side sport=unknown + fuzzy match → 0.6
// ─────────────────────────────────────────────────────────
test("bypass: flag on + market sport=unknown + fuzzy team match → 0.6 with bypass_reason", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ sport: "mlb" }),
      marketRow({ sport: "unknown", home_team: "Red Sox", away_team: "Brewers" }),
    );
    assert.equal(out.score, 0.6);
    assert.equal(out.reasons.bypass_reason, "teams_match_unknown_sport");
    assert.equal(out.reasons.event_sport, "mlb");
    assert.equal(out.reasons.market_sport, "unknown");
  });
});

test("bypass: flag on + event sport=unknown + fuzzy team match → 0.6 with bypass_reason", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ sport: "unknown" }),
      marketRow({ sport: "mlb", home_team: "Red Sox", away_team: "Brewers" }),
    );
    assert.equal(out.score, 0.6);
    assert.equal(out.reasons.bypass_reason, "teams_match_unknown_sport");
  });
});

test("bypass: flag on + EXACT teams path ignores bypass (keeps 1.0 for normal sport-equality)", () => {
  // Bypass is only engaged on the fuzzy path. Exact teams with same date stays at 1.0.
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ sport: "mlb" }),
      marketRow({ sport: "unknown" }),
    );
    assert.equal(out.score, 1.0);
    assert.equal(out.reasons.bypass_reason, undefined);
  });
});

// ─────────────────────────────────────────────────────────
// Negative cases
// ─────────────────────────────────────────────────────────
test("no bypass: flag off + market sport=unknown + fuzzy → keeps 0.9 baseline", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "false" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ sport: "mlb" }),
      marketRow({ sport: "unknown", home_team: "Red Sox", away_team: "Brewers" }),
    );
    assert.equal(out.score, 0.9);
    assert.equal(out.reasons.bypass_reason, undefined);
  });
});

test("no bypass: flag on + market missing away_team → score=0 missing_team", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ sport: "mlb" }),
      marketRow({ sport: "unknown", away_team: null }),
    );
    assert.equal(out.score, 0);
    assert.equal(out.reasons.reason, "missing_team");
    assert.equal(out.reasons.bypass_reason, undefined);
  });
});

test("no bypass: teams do not fuzzy-match → score=0.08 teams_no_match", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ sport: "mlb" }),
      marketRow({
        sport: "unknown",
        home_team: "Kansas City Royals",
        away_team: "Cleveland Guardians",
      }),
    );
    assert.equal(out.score, 0.08);
    assert.equal(out.reasons.bypass_reason, undefined);
  });
});

test("no bypass: neither side is unknown → ignore bypass path, keep normal scoring", () => {
  // Both classified as mlb → bypass doesn't apply, fuzzy path returns 0.9.
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ sport: "mlb" }),
      marketRow({
        sport: "mlb",
        home_team: "Red Sox",
        away_team: "Brewers",
      }),
    );
    assert.equal(out.score, 0.9);
    assert.equal(out.reasons.bypass_reason, undefined);
  });
});

test("no bypass: category mismatch (event.category=politics) → no bypass even with flag", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const out = scoreSportsAttachmentDetailed(
      eventRow({ category: "politics", sport: "unknown" }),
      marketRow({ category: "politics", sport: "unknown", home_team: "Red Sox", away_team: "Brewers" }),
    );
    // bypass eligibility requires BOTH sides category='sports'; fuzzy path returns normal 0.9.
    assert.equal(out.score, 0.9);
    assert.equal(out.reasons.bypass_reason, undefined);
  });
});

// ─────────────────────────────────────────────────────────
// normalizeTeamName extensions
// ─────────────────────────────────────────────────────────
test("normalizeTeamName strips 'Saudi Club' suffix", () => {
  assert.equal(normalizeTeamName("Al Nassr Saudi Club"), "al nassr");
  assert.equal(normalizeTeamName("Al Ettifaq Saudi Club"), "al ettifaq");
});

test("normalizeTeamName strips AFC suffix", () => {
  assert.equal(normalizeTeamName("Barrow AFC"), "barrow");
});

test("normalizeTeamName does NOT strip distinguishing tokens (United, City)", () => {
  assert.notEqual(normalizeTeamName("Manchester United"), normalizeTeamName("Manchester City"));
  assert.equal(normalizeTeamName("Manchester United"), "manchester united");
  assert.equal(normalizeTeamName("Manchester City"), "manchester city");
});

test("normalizeTeamName still strips FC/SC/CF as before", () => {
  assert.equal(normalizeTeamName("Inter Miami CF"), "inter miami");
  assert.equal(normalizeTeamName("Orlando City SC"), "orlando city");
});

// ─────────────────────────────────────────────────────────
// Non-sports path must remain untouched
// ─────────────────────────────────────────────────────────
test("non-sports (politics) path unchanged under flag", () => {
  withEnv({ LINKER_H2H_TEAMS_BYPASS: "true" }, () => {
    const score = scoreEventAttachment(
      { category: "politics", subcategory: "elections", event_date: "2026-04-24", title: "A" },
      { category: "politics", subcategory: "elections", game_date: "2026-04-24", title: "A" },
    );
    assert.ok(score > 0);
  });
});
