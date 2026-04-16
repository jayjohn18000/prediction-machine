# Phase E1 — Sports Expansion Plan

> Created: 2026-03-30
> Status: Planning — entry criteria met (Phase D semantic closeout complete)
> Agent roles: Cursor for code (driven manually or by a Cowork sub-agent via GUI automation — see `cursor-orchestrator` skill); Claude Cowork for orchestration + verification
> ⚠️ Amended 2026-04-15: earlier versions named OpenClaw (Plumbo) as the code executor. OpenClaw has been retired; Cursor is now the sole non-Cowork executor.

---

## Entry criteria (all met)
- [x] Phase D semantic closeout complete (0 residual invalid links, strict audit passes)
- [x] Observer running, freshness <120s
- [x] All SLOs green (ingestion_success=1.00, p95=124ms)
- [x] Guard-first proposer + strict-audit gate loop battle-tested on politics

---

## Guiding principle
Use the exact same loop as Phase D: ingest → propose → review → audit → guard. Start with a narrow slice (one sport, one market type), expand only when semantic drift stays at zero. Do not expand faster than the audit gate can validate.

---

## E1.0 — Discovery & Schema Design

### E1.0.1 — Identify sports series tickers on Kalshi
Run discovery against Kalshi for sports-related series:
```bash
# Add to package.json:
"pmci:discover:sports:kalshi": "node scripts/discovery/pmci-discover-kalshi-sports-series.mjs"
```
Script should query Kalshi for series with category hints: NFL, NBA, MLB, NHL, soccer.
Print discovered tickers to stdout (do not auto-write to env).

### E1.0.2 — Identify sports tag IDs on Polymarket
Fetch Polymarket tag list and identify sports-related tag_ids:
```bash
"pmci:discover:sports:poly": "node scripts/discovery/pmci-discover-polymarket-sports-tags.mjs"
```
Cross-reference with Kalshi discoveries to find events likely present on both platforms.

### E1.0.3 — Define sports canonical event schema
Sports markets differ from politics in three key ways:
1. **Short-lived:** game markets open ~1 week before game, settle same day or next day
2. **Team/player-based:** canonical entity is a team, matchup, or player — not a person running for office
3. **Rapid turnover:** a "canonical event" may be a game (Bears vs. Packers, 2026-09-12) — gone in 24h after resolution

Proposed `canonical_event` shape for sports:
```json
{
  "slug": "nfl-bears-packers-2026-09-12",
  "category": "sports",
  "sport": "nfl",
  "event_type": "game_result",
  "home_team": "Chicago Bears",
  "away_team": "Green Bay Packers",
  "game_date": "2026-09-12",
  "metadata": {
    "league": "NFL",
    "season": "2026-2027",
    "week": 2
  }
}
```

**Hard gate E1.0:** At least 5 sports events identified on both Kalshi and Polymarket simultaneously.

---

## E1.1 — Schema Migration

### E1.1.1 — Add sports columns to provider_markets
Create migration `supabase/migrations/YYYYMMDD_sports_market_fields.sql`:
```sql
ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS sport text,
  ADD COLUMN IF NOT EXISTS event_type text
    CHECK (event_type IN ('game_result', 'season_award', 'draft_pick', 'player_prop', 'championship', 'unknown')),
  ADD COLUMN IF NOT EXISTS game_date date,
  ADD COLUMN IF NOT EXISTS home_team text,
  ADD COLUMN IF NOT EXISTS away_team text;

COMMENT ON COLUMN pmci.provider_markets.sport IS 'Sport code: nfl, nba, mlb, nhl, soccer, etc.';
COMMENT ON COLUMN pmci.provider_markets.event_type IS 'Sports market type';
COMMENT ON COLUMN pmci.provider_markets.game_date IS 'Game/event date for short-lived markets';
```

Run: `npx supabase db push` then `npm run verify:schema`

### E1.1.2 — Add sports lifecycle to canonical_events
```sql
ALTER TABLE pmci.canonical_events
  ADD COLUMN IF NOT EXISTS lifecycle text
    CHECK (lifecycle IN ('active', 'settled', 'archived', 'cancelled'))
    DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS resolves_at timestamptz;

COMMENT ON COLUMN pmci.canonical_events.lifecycle IS
  'For sports: settled after game result, archived after N days (no open markets remain)';
```

**Hard gate E1.1:** `npm run verify:schema` passes with new columns present.

---

## E1.2 — Ingestion Adaptation

### E1.2.1 — Create sports universe ingestion script
```bash
"pmci:ingest:sports:universe": "node scripts/ingestion/pmci-ingest-sports-universe.mjs"
```

Key differences from politics universe ingest:
- Filter by sports series tickers (env: `PMCI_SPORTS_KALSHI_SERIES_TICKERS`)
- Filter by sports tag_ids on Polymarket (env: `PMCI_SPORTS_POLY_TAG_IDS`)
- Populate `sport`, `event_type`, `game_date`, `home_team`, `away_team` during ingest
- Set `category = 'sports'` on all ingested markets
- Respect same 429 retry-with-backoff pattern as politics universe script

### E1.2.2 — Infer sports fields during ingestion
```js
function inferSportFromTicker(ticker) {
  if (/^NFL/i.test(ticker)) return 'nfl';
  if (/^NBA/i.test(ticker)) return 'nba';
  if (/^MLB/i.test(ticker)) return 'mlb';
  if (/^NHL/i.test(ticker)) return 'nhl';
  return 'unknown';
}

function inferGameDate(ticker, title) {
  // Extract dates like 2026-09-12 from ticker or title
  const m = (ticker + ' ' + title).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}
```

### E1.2.3 — Rapid turnover handling
Sports markets settle and disappear quickly. The ingestion loop must:
1. Mark markets as `status='settled'` when the provider returns `status=closed/resolved`
2. Auto-archive `canonical_events` where `lifecycle='settled'` AND all linked markets have been closed for >7 days
3. Never delete — always archive (`lifecycle='archived'`) for audit trail

**Hard gate E1.2:** After first ingest run: `SELECT COUNT(*) FROM pmci.provider_markets WHERE category='sports' AND sport != 'unknown'` > 0.

---

## E1.3 — Canonical Event Seed for Sports

### E1.3.1 — Create sports canonical events seeding script
```bash
"seed:sports:pmci": "node scripts/seed/seed-pmci-sports-families-links.mjs"
```

Unlike politics (where events were pre-known), sports canonical events should be **auto-generated** from the ingested provider_markets:
- Group Kalshi sports markets by game/matchup (team pair + date)
- Create a `canonical_event` per unique game
- Use slug format: `{sport}-{team_a}-{team_b}-{YYYY-MM-DD}`

**Hard gate E1.3:** At least 3 sports canonical events created with at least 1 provider market each.

---

## E1.4 — Proposer + Reviewer Adaptation

### E1.4.1 — Add sports topic signature patterns to proposal-engine.mjs
Extend `TOPIC_KEY_PATTERNS` with sports-specific patterns:
```js
// NFL game markets
{ re: /\b(nfl|football)\b.{0,60}\b([a-z]+ [a-z]+)\b\s+vs?\s+\b([a-z]+ [a-z]+)\b/i,
  key: (m) => `nfl_${normalize(m[2])}_vs_${normalize(m[3])}` },
// Generic game result
{ re: /\bwin(s|ner)?\b.{0,40}\b(super bowl|championship|title)\b/i,
  key: (m) => `championship_${normalize(m[2])}` },
```

### E1.4.2 — Add sports guard to proposal engine
Before proposing any cross-platform link for sports markets, add a guard:
- `game_date` must match within 1 day between Kalshi and Polymarket legs
- `sport` must match (nfl ≠ nba)
- If either market has `lifecycle != 'active'`, reject with `stale_market` reason

```bash
"pmci:propose:sports": "node scripts/review/pmci-propose-links-sports.mjs"
"pmci:check:sports:proposals": "node scripts/review/pmci-check-sports-proposals.mjs"
```

**Hard gate E1.4:** Proposer runs without error. At least 1 sports proposal generated for review (or confirmed-0 with logged reason).

---

## E1.5 — Audit & Validation

### E1.5.1 — Sports semantic integrity check
Add to `npm run pmci:probe` output:
```sql
-- Sports coverage by sport
SELECT
  sport,
  provider,
  COUNT(DISTINCT id) AS total,
  COUNT(DISTINCT id) FILTER (WHERE status = 'active') AS active,
  COUNT(DISTINCT id) FILTER (WHERE game_date < NOW()::date AND status = 'active') AS stale_active
FROM pmci.provider_markets
WHERE category = 'sports'
GROUP BY 1, 2 ORDER BY 1, 2;
```

Flag `stale_active > 0` as a warning — game has passed but market not yet settled.

### E1.5.2 — Sports strict audit packet
```bash
"pmci:audit:sports:packet": "node scripts/audit/pmci-sports-audit-packet.mjs"
```

Acceptance criteria for E1 closeout:
- `stale_active = 0` (no games-passed markets still marked active)
- `sport = 'unknown'` count = 0 for ingested sports markets
- All sports proposals either accepted, rejected, or skipped
- Zero semantic integrity violations (wrong sport linked, date mismatch > 1 day)

**Hard gate E1.5:** Strict audit packet generates with zero violations.

---

## Verification sequence (run in order)

```bash
npm run pmci:discover:sports:kalshi      # E1.0: find Kalshi sports tickers
npm run pmci:discover:sports:poly        # E1.0: find Polymarket sports tags
npm run pmci:ingest:sports:universe      # E1.2: ingest sports markets
npm run pmci:probe                       # E1.2: verify sports rows + sport field populated
npm run seed:sports:pmci                 # E1.3: create canonical events
npm run pmci:propose:sports              # E1.4: generate proposals
npm run pmci:review                      # E1.4: process proposals (--accept/--reject/--skip)
npm run pmci:audit:sports:packet         # E1.5: strict audit — zero violations
npm run verify:schema                    # confirm all migrations applied
```

---

## Files to read before editing (in order)

1. `lib/ingestion/universe.mjs` — pattern to follow for new sports ingest
2. `lib/matching/proposal-engine.mjs` — extend TOPIC_KEY_PATTERNS and add sport guard
3. `lib/providers/kalshi.mjs` — API client pattern for sports series discovery
4. `lib/providers/polymarket.mjs` — tag-based event fetch pattern
5. `supabase/migrations/` — latest migration before any schema change
6. `scripts/ingestion/pmci-ingest-politics-universe.mjs` — template for sports universe script
7. `scripts/review/pmci-propose-links-politics.mjs` — template for sports proposer

---

## Do NOT do

- Do not auto-write to `.env`
- Do not bulk-inactivate markets without inactive-guard check
- Do not skip `npm run verify:schema` after migrations
- Do not link markets across different sports (nfl ≠ nba)
- Do not link markets where game_date delta > 1 day
- Do not expand to NBA/MLB until NFL slice is validated with zero semantic drift
- Do not delete settled markets — archive them (`lifecycle='archived'`)
- Do not anchor on any external count as a target — verify with your own DB queries

---

## Migration path to E2 (Crypto)
- Entry: E1 strict audit passes, at least 1 sport fully linked with zero violations
- E2 challenge: crypto markets are continuous price events (BTC > $100k by EOY), not binary yes/no
- Spread computation model for non-binary markets is a new problem — design in E2 planning
