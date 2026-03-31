# Phase E1 — Sports Canonical Event Schema & Data Model

**Status:** Design (pre-implementation)
**Related:** `docs/phase-e1-sports-plan.md`

This document defines the canonical data model for sports markets and captures the design decisions made before implementation begins. Lock this document before writing any E1 code.

---

## 1. Sports vs. Politics: Model Differences

The existing politics model was designed for long-lived, candidate-centric events with a fixed outcome set. Sports events require a more flexible model with two distinct event classes.

| Dimension | Politics | Sports: Championship | Sports: Game |
|-----------|---------|---------------------|-------------|
| Typical lifetime | 1–4 years | 2–6 months | 12–48 hours |
| Entity model | Named candidate (person) | Team / league | Team A vs Team B |
| Market count per event | 10–100 per nominee slot | 10–40 per team | 3–20 per game (spread, total, winner) |
| Resolution | Election result | Season end | Game final score |
| Canonical ID stability | Stable until election | Stable for season | Stable once scheduled |
| Turnover | Low (new candidates emerge slowly) | Low (teams are known pre-season) | High (new game every day in-season) |

**Design principle:** The schema must accommodate both event classes without creating two separate canonical event tables. This is achieved via `metadata` JSONB and a new `event_type` field therein.

---

## 2. Canonical Event Schema for Sports

### 2.1 `pmci.canonical_events` — No New Columns Required

The existing table schema is sufficient for v1 sports. All sports-specific metadata goes into the existing `metadata` JSONB column. No DB migration is needed.

Existing columns in use:
```
id          UUID (primary key)
slug        TEXT UNIQUE
title       TEXT
category    TEXT  -- 'sports'
description TEXT  -- optional, human-readable
metadata    JSONB -- all sports-specific fields live here
created_at  TIMESTAMPTZ
updated_at  TIMESTAMPTZ
```

### 2.2 Sports Metadata Schema (JSONB)

All sports events must include these fields in `metadata`:

```jsonc
{
  // Required for all sports events
  "sport":       "football",       // normalized sport name (see §3)
  "league":      "nfl",            // league abbreviation (see §3)
  "season":      "2025-2026",      // season string, e.g. "2025" for MLB/NBA or "2025-2026" for NFL/NHL
  "event_type":  "championship",   // "championship" | "game" | "season_award" | "playoff"

  // Required for game events only
  "team_home":   "kansas city chiefs",  // normalized team name (lowercase, full name)
  "team_away":   "philadelphia eagles",
  "game_date":   "2026-02-08",          // ISO date of scheduled game (UTC)
  "game_time":   "23:30:00Z",           // optional, ISO time

  // Optional for all events
  "single_platform": false,        // true if only seen on one provider (mirrors politics pattern)
  "venue":       "caesars superdome",   // optional
  "playoff_round": "championship"       // optional, e.g. "wild_card", "divisional", "conference", "championship"
}
```

### 2.3 Slug Format Conventions

Slugs must be deterministic and human-readable.

**Championship events:**
```
{league}-{season}-{award-type}
# Examples:
nfl-2025-2026-super-bowl-winner
nba-2025-2026-championship-winner
mlb-2025-world-series-winner
nhl-2025-2026-stanley-cup-winner
```

**Game events:**
```
{league}-{game_date}-{team_away}-at-{team_home}
# Examples:
nfl-2026-02-08-eagles-at-chiefs
nba-2026-01-15-lakers-at-celtics
```

**Season award events (MVP, ROY, etc.):**
```
{league}-{season}-{award-name}
# Examples:
nfl-2025-2026-mvp
nba-2025-2026-mvp
```

---

## 3. Normalized Sport and League Values

All `sport` and `league` values must be normalized at ingestion time. These are the canonical values — no variants.

### Sports
```
football
basketball
baseball
hockey
soccer
golf
tennis
mma
boxing
other_sports
```

### Leagues
```
# Football
nfl
ncaa_football
cfl

# Basketball
nba
ncaa_basketball
wnba

# Baseball
mlb
ncaa_baseball

# Hockey
nhl

# Soccer
mls
premier_league
champions_league
la_liga
bundesliga
serie_a

# Golf
pga
lpga
masters       # (use for standalone tournament events)

# Tennis
atp
wta
grand_slam

# Combat sports
ufc
boxing

# Other
other
```

---

## 4. `inferCategory()` Subcategory Mapping

Update both `lib/providers/kalshi-adapter.mjs` and `lib/providers/polymarket-adapter.mjs` to return sport-specific subcategories instead of the generic `'game'` stub.

The `subcategory` field should match the normalized `sport` value from §3.

### Kalshi Category Name → PMCI Subcategory

Kalshi uses human-readable category names. Known mappings (verify against live API in E1.0):

```js
const KALSHI_SPORTS_CATEGORY_MAP = {
  'sports':      'other_sports',   // fallback if Kalshi uses umbrella category
  'basketball':  'basketball',
  'nba':         'basketball',
  'football':    'football',
  'nfl':         'football',
  'baseball':    'baseball',
  'mlb':         'baseball',
  'hockey':      'hockey',
  'nhl':         'hockey',
  'soccer':      'soccer',
  'mls':         'soccer',
  'golf':        'golf',
  'pga':         'golf',
  'tennis':      'tennis',
  'mma':         'mma',
  'ufc':         'mma',
};
```

### Polymarket Tag Slug → PMCI Subcategory

Polymarket uses tag slugs on event objects (check `event.tags[]` array):

```js
const POLYMARKET_SPORTS_TAG_MAP = {
  'sports':      'other_sports',
  'nfl':         'football',
  'nba':         'basketball',
  'mlb':         'baseball',
  'nhl':         'hockey',
  'soccer':      'soccer',
  'mls':         'soccer',
  'golf':        'golf',
  'tennis':      'tennis',
  'ufc':         'mma',
  'boxing':      'boxing',
};
```

---

## 5. Market Family and Link Model for Sports

No changes to `pmci.market_families` or `pmci.market_links` tables. Sports uses the same schema.

### Market Family Structure

Each canonical sports event gets one or more market families. For championship events:

```
canonical_event: "nfl-2025-2026-super-bowl-winner"
  └── family: "Super Bowl LX Winner"
        ├── link: Kalshi market (e.g., SUPERBOWL-LX)
        └── link: Polymarket market (e.g., super-bowl-lx-winner)
```

For game events (when enabled):

```
canonical_event: "nfl-2026-02-08-eagles-at-chiefs"
  ├── family: "Game Winner"
  │     ├── link: Kalshi NFLWIN-0208-PHI-KC
  │     └── link: Polymarket eagles-vs-chiefs-winner
  ├── family: "Total Points Over/Under" (future)
  └── family: "Spread" (future)
```

### Relationship Types for Sports

Use existing `relationship_type` enum values:
- `identical` — exact same binary market (winner market on both platforms)
- `equivalent` — semantically equivalent (both ask "Will X win championship?" with same outcome)
- `proxy` — correlated but not identical (game total on Kalshi, game spread on Polymarket)
- `correlated` — loosely related (avoid using for sports v1; reserve for future)

---

## 6. Canonical Event Lifecycle Policy

### Status Values (existing `status` column, or metadata flag)

Sports events progress through these states:

| Status | Meaning | Action |
|--------|---------|--------|
| `active` | Markets open on at least one platform | Normal ingestion + linking |
| `pending` | Event seeded but no provider markets found yet | Poll for markets; auto-promote to `active` |
| `closed` | All linked provider markets settled/expired | Exclude from API defaults; keep for history |
| `cancelled` | Event did not happen (game postponed indefinitely, etc.) | Rare; manual annotation |

### Archival Script (E1 post-launch, not a blocker)

After the pipeline is validated, create `scripts/pmci-sports-archive-closed.mjs`:
- Query `pmci.provider_markets` where `category='sports'` and `status IN ('settled','expired','closed')`
- If all provider markets for a canonical event are closed, update `canonical_events.metadata.status = 'closed'`
- Run on a weekly cron or as a manual CLI step
- Do not hard-delete — keep rows for historical divergence analysis

---

## 7. Proposal Engine Scoring for Sports

The sports proposal engine in `lib/matching/sports-proposal-engine.mjs` must use a different scoring formula than politics.

### Blocking Strategy

Group candidate pairs by `(sport, league, season)` before scoring. Never compare across leagues. This is the sports equivalent of the politics topic-key blocking.

```js
function getSportsBlockKey(market) {
  const meta = market.metadata || {};
  return `${meta.sport || 'unknown'}::${meta.league || 'unknown'}::${meta.season || 'unknown'}`;
}
```

### Scoring Dimensions

| Dimension | Weight | Notes |
|-----------|--------|-------|
| Team name overlap | 0.35 | Primary signal; use `SPORTS_TEAM_ALIASES` for normalization |
| Title token jaccard | 0.25 | Secondary; covers "Super Bowl", "championship", "winner" etc. |
| League match | 0.20 | Hard gate: 0 if leagues differ |
| Date proximity | 0.15 | For game markets: 1.0 if same date, 0.5 if ±1 day, 0.0 if >2 days. For championship markets: 1.0 if same season |
| Market structure | 0.05 | Bonus if both are binary winner markets |

**Minimum confidence threshold:** 0.88 (same as politics)

### Team Name Alias Dictionary

`lib/matching/sports-entity-parse.mjs` must ship a `SPORTS_TEAM_ALIASES` dictionary covering at minimum the NFL (32 teams), NBA (30 teams), and MLB (30 teams). Aliases should include:
- Short nickname: `"chiefs"` → `"kansas city chiefs"`
- City only: `"kansas city"` → `"kansas city chiefs"`
- Common abbreviations: `"kc"` → `"kansas city chiefs"`, `"phi"` → `"philadelphia eagles"`
- Polymarket title variants (often use short names like `"Chiefs"` or `"Eagles"`)

---

## 8. Coverage and SLO Impact

### New Coverage Metrics

After E1.5, `GET /v1/coverage/summary?category=sports` should report:
```json
{
  "category": "sports",
  "canonical_events": 2,
  "provider_markets": { "kalshi": N, "polymarket": M },
  "active_links": K,
  "coverage_rate": "K / max(N,M)"
}
```

**Important:** Add `?category` filter enforcement to `src/routes/coverage.mjs` before sports goes live. Without it, the endpoint double-counts across categories (documented risk in `system-state.md`).

### SLO Guard

Sports ingestion is additive. Politics SLOs must not degrade:
- `ingestion_success` target: 0.99 (shared across all categories)
- `freshness_lag` target: ≤ 120s (shared)
- `api_p95_latency` target: < 500ms (may require index review if sports adds significant row volume)

If game markets are enabled later, the `provider_market_snapshots` table will grow significantly (potentially 100+ new markets/day during active sports seasons). Plan a table partitioning or TTL strategy before enabling game markets at scale.

---

## 9. Open Questions (resolve before E1.2)

1. **Does Kalshi's `/series` endpoint accept `?category=sports` or does it use sport-specific categories like `?category=Basketball`?** Must be confirmed in E1.0 manual probe. Determines Option A vs Option B in discovery script.

2. **Does Polymarket use a `sports` umbrella tag or per-sport tags only?** If per-sport only, the discovery script must enumerate each sport slug separately.

3. **Should the sports proposal engine be a fork of the politics engine or a complete rewrite?** Recommendation: new file (`sports-proposal-engine.mjs`) that imports shared utilities from `lib/matching/scoring.mjs` but has its own topic-key and entity logic. Avoids risk of polluting the validated politics engine.

4. **When do we enable game-level markets?** Not before: (a) at least 2 championship markets are successfully linked and audited, (b) a row budget for `provider_market_snapshots` is confirmed acceptable, (c) the archival script is in place.

5. **Multi-outcome sports markets:** Some Polymarket sports events are multi-outcome (e.g., "Which team wins the NBA championship?" with 30 team options), not binary. The existing `market_type = 'binary'` assumption in the canonical schema does not cover this. For v1, skip multi-outcome markets and binary-only. Add `market_type = 'categorical'` in a future sub-phase.
