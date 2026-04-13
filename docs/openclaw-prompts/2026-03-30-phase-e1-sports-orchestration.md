# Orchestration Prompt: Phase E1 — Sports Expansion
> Generated: 2026-03-30
> Agents: OpenClaw (Plumbo) for code | Claude Cowork for orchestration + verification

---

## Read these files first (in order)

Before writing any code, read:
1. `CLAUDE.md` — project overview, invariants, current state
2. `docs/plans/phase-e1-sports-plan.md` — full E1 phase plan with hard gates
3. `docs/roadmap.md` — phase context and acceptance criteria
4. `lib/ingestion/universe.mjs` — ingest loop pattern to replicate for sports
5. `lib/matching/proposal-engine.mjs` — proposal engine to extend with sports patterns
6. `lib/providers/kalshi.mjs` — Kalshi API client
7. `scripts/ingestion/pmci-ingest-politics-universe.mjs` — template for sports universe script

---

## Context

You are implementing Phase E1 (Sports Expansion) of the Prediction Machine project — a cross-platform prediction market intelligence platform that normalizes and cross-links markets from Kalshi and Polymarket.

Phases A–D are complete:
- Infrastructure hardened, all SLOs green
- Politics normalization complete: 138 active cross-platform links, 2 canonical events (2028 Dem/Rep nominees), zero semantic integrity violations
- Guard-first proposer + strict-audit gate loop is the validated pattern — use it for sports

Phase E1 goal: onboard sports markets (start with NFL) using the exact same pipeline as politics.

---

## Agent roles

**OpenClaw (Plumbo):**
- Write and edit all code files (scripts, lib, migrations, src)
- Run terminal commands (npm scripts, SQL, git)
- Create new scripts following patterns from existing politics pipeline
- Make all schema migrations

**Claude (Dispatch/Cowork):**
- Orchestrate phases and check hard gates
- Run verification commands and read output
- Probe the live API (`curl http://localhost:8787/v1/*`)
- Handle git commits of completed phases
- Keep audit trail and update `docs/system-state.md` after each phase

---

## Phase sequence with hard gates

Work through phases in order. Do not advance until the hard gate passes.

### Phase E1.0 — Discovery
**OpenClaw tasks:**
- Create `scripts/discovery/pmci-discover-kalshi-sports-series.mjs`
  - Query Kalshi for series with sports-related category/tickers (NFL, NBA, MLB, NHL)
  - Print discovered tickers to stdout only — do not auto-write to env
  - Add to package.json: `"pmci:discover:sports:kalshi": "node scripts/discovery/pmci-discover-kalshi-sports-series.mjs"`
- Create `scripts/discovery/pmci-discover-polymarket-sports-tags.mjs`
  - Fetch Polymarket tag list, filter sports-related tag_ids
  - Print to stdout
  - Add to package.json: `"pmci:discover:sports:poly": "node scripts/discovery/pmci-discover-polymarket-sports-tags.mjs"`

**Claude verification:**
```bash
npm run pmci:discover:sports:kalshi
npm run pmci:discover:sports:poly
```

**Hard gate E1.0:** At least 5 sports events identified on both Kalshi and Polymarket simultaneously.

---

### Phase E1.1 — Schema Migration
**OpenClaw tasks:**
- Create migration `supabase/migrations/YYYYMMDD_sports_market_fields.sql` adding to `provider_markets`:
  - `sport text` (nfl, nba, mlb, nhl, soccer, unknown)
  - `event_type text` CHECK (game_result, season_award, draft_pick, player_prop, championship, unknown)
  - `game_date date`
  - `home_team text`
  - `away_team text`
- Add to `canonical_events`:
  - `lifecycle text` CHECK (active, settled, archived, cancelled) DEFAULT 'active'
  - `resolves_at timestamptz`
- Run `npx supabase db push`

**Claude verification:**
```bash
npm run verify:schema
npm run pmci:smoke
```

**Hard gate E1.1:** `npm run verify:schema` passes with new columns present.

---

### Phase E1.2 — Sports Universe Ingestion
**OpenClaw tasks:**
- Create `scripts/ingestion/pmci-ingest-sports-universe.mjs` modeled on `pmci-ingest-politics-universe.mjs`
  - Use env vars: `PMCI_SPORTS_KALSHI_SERIES_TICKERS`, `PMCI_SPORTS_POLY_TAG_IDS`
  - Populate `sport`, `event_type`, `game_date`, `home_team`, `away_team` during ingest
  - Set `category = 'sports'` on all ingested markets
  - Infer sport from ticker prefix (NFL→nfl, NBA→nba, etc.)
  - Extract game_date from ticker or title (regex: `\b(\d{4}-\d{2}-\d{2})\b`)
  - Same 429 retry-with-backoff as politics script
  - Add: `"pmci:ingest:sports:universe": "node scripts/ingestion/pmci-ingest-sports-universe.mjs"`
- Handle rapid turnover: mark `status='settled'` when provider returns closed/resolved
- Never delete — always archive (`lifecycle='archived'`) for audit trail

**Claude verification:**
```bash
npm run pmci:ingest:sports:universe
# Then verify:
# SELECT COUNT(*) FROM pmci.provider_markets WHERE category='sports' AND sport != 'unknown'
```

**Hard gate E1.2:** Count > 0 for sports markets with known sport field.

---

### Phase E1.3 — Canonical Event Seed
**OpenClaw tasks:**
- Create `scripts/seed/seed-pmci-sports-families-links.mjs`
  - Auto-generate canonical events from ingested sports provider_markets
  - Group Kalshi sports markets by game/matchup (team pair + game_date)
  - Create canonical_event per unique game with slug: `{sport}-{team_a}-{team_b}-{YYYY-MM-DD}`
  - Add: `"seed:sports:pmci": "node scripts/seed/seed-pmci-sports-families-links.mjs"`

**Claude verification:**
```bash
npm run seed:sports:pmci
curl -s "http://localhost:8787/v1/coverage/summary?category=sports"
```

**Hard gate E1.3:** At least 3 sports canonical events created, each with ≥1 provider market.

---

### Phase E1.4 — Proposer + Reviewer
**OpenClaw tasks:**
- Extend `lib/matching/proposal-engine.mjs` TOPIC_KEY_PATTERNS with sports patterns:
  - NFL game matchup pattern (team A vs team B)
  - Generic championship/award pattern
- Add sports guard to proposer:
  - `game_date` must match within 1 day between legs
  - `sport` must match
  - Reject with `stale_market` if `lifecycle != 'active'`
- Create `scripts/review/pmci-propose-links-sports.mjs` (model on politics proposer)
  - Add: `"pmci:propose:sports": "node scripts/review/pmci-propose-links-sports.mjs"`
- Create `scripts/review/pmci-check-sports-proposals.mjs`
  - Add: `"pmci:check:sports:proposals": "node scripts/review/pmci-check-sports-proposals.mjs"`

**Claude verification:**
```bash
npm run pmci:propose:sports
npm run pmci:review   # process proposals --accept/--reject/--skip
curl -s "http://localhost:8787/v1/review/queue?category=sports&limit=5"
```

**Hard gate E1.4:** Proposer runs without error. At least 1 proposal generated (or 0 with logged reason — not a silent failure).

---

### Phase E1.5 — Audit & Validation
**OpenClaw tasks:**
- Add sports coverage block to `npm run pmci:probe` output:
  ```sql
  SELECT sport, provider, COUNT(*) total,
    COUNT(*) FILTER (WHERE status='active') active,
    COUNT(*) FILTER (WHERE game_date < NOW()::date AND status='active') stale_active
  FROM pmci.provider_markets WHERE category='sports'
  GROUP BY 1, 2 ORDER BY 1, 2;
  ```
- Create `scripts/audit/pmci-sports-audit-packet.mjs`
  - Add: `"pmci:audit:sports:packet": "node scripts/audit/pmci-sports-audit-packet.mjs"`
  - Checks: stale_active=0, sport='unknown' count=0, zero semantic violations

**Claude verification:**
```bash
npm run pmci:probe
npm run pmci:audit:sports:packet
npm run verify:schema
```

**Hard gate E1.5 (phase closeout):**
- `stale_active = 0`
- `sport = 'unknown'` count = 0
- Zero semantic integrity violations (wrong sport linked, date mismatch >1 day)
- Strict audit packet generates cleanly

---

## Invariants (never violate)
- Do not auto-write to `.env` — print proposed env changes to stdout only
- Do not bulk-inactivate markets without inactive-guard check
- Do not skip `npm run verify:schema` after any migration
- Do not link markets across different sports (nfl ≠ nba)
- Do not link markets where game_date delta > 1 day
- Do not expand to NBA/MLB until NFL slice shows zero semantic drift
- Do not delete settled markets — archive them (`lifecycle='archived'`)
- Do not add new PMCI routes to root `api.mjs` — use `src/api.mjs` only

---

## How to orchestrate between OpenClaw and Claude

**Handoff pattern:**
1. Claude reads this prompt, identifies which phase to start
2. Claude sends OpenClaw the specific phase task (E1.0, E1.1, etc.) with explicit file paths and hard gate
3. OpenClaw writes the code and runs the npm script
4. Claude runs the verification commands and checks the hard gate
5. If gate passes → Claude commits the phase files and advances to next phase
6. If gate fails → Claude diagnoses from output and sends OpenClaw a targeted fix

**Git discipline:**
- Commit after each phase passes its hard gate
- Commit message format: `feat(pmci): phase E1.X — [description]`
- Do not commit auto-generated files (`*.generated.json`, `*.env`, `*.csv`, checkpoint JSON)

**When stuck:**
- Check `docs/system-state.md` for known risks
- Check `docs/decision-log.md` for prior architectural decisions
- Read the politics equivalent script as a template before writing sports equivalent
- Run `npm run pmci:probe` for a full system health snapshot

---

## Starting point

Begin with Phase E1.0 (Discovery). Your first task to OpenClaw:

> "Read `CLAUDE.md` and `docs/plans/phase-e1-sports-plan.md` first. Then create two discovery scripts: `scripts/discovery/pmci-discover-kalshi-sports-series.mjs` and `scripts/discovery/pmci-discover-polymarket-sports-tags.mjs`. Follow the Kalshi client pattern in `lib/providers/kalshi.mjs` and the Polymarket client in `lib/providers/polymarket.mjs`. Print all discovered tickers/tag_ids to stdout only — do not auto-write to env. Add both to package.json. Hard gate: at least 5 sports events identifiable on both platforms."
