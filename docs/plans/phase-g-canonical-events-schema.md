# Phase G: Canonical Event Architecture — Schema & Architecture

## Data Models

### Core hierarchy

```
canonical_event (ground-truth occurrence)
  └── provider_event_map (Kalshi event → canonical, Polymarket event → canonical)
        └── provider_market (individual market contract)
              └── provider_market_map (market → canonical_market slot)

canonical_market (market-type slot within an event: moneyline, total, spread, etc.)
  └── provider_market_map (links two provider_markets as equivalent)
```

### Table: `pmci.canonical_events`

Represents a verifiable real-world occurrence with a specific resolution date.

```sql
-- Confirm existing table matches or ALTER to match:
CREATE TABLE IF NOT EXISTS pmci.canonical_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category      text NOT NULL,                          -- 'sports', 'politics', 'economics', 'crypto'
  subcategory   text,                                   -- 'mlb', 'nba', 'fomc', 'btc_price', 'senate_race'
  title         text NOT NULL,                          -- Canonical human-readable: "Oakland Athletics @ New York Yankees"
  event_date    date NOT NULL,                          -- Primary resolution/occurrence date
  event_time    timestamptz,                            -- Precise kickoff/release time if known
  participants  jsonb DEFAULT '[]',                     -- [{name: "Oakland Athletics", role: "away"}, {name: "New York Yankees", role: "home"}]
  external_ref  text,                                   -- TheSportsDB event ID, FOMC meeting ID, election race ID, etc.
  external_source text,                                 -- 'thesportsdb', 'fed_calendar', 'google_civic', 'coingecko', 'market_seeded'
  metadata      jsonb DEFAULT '{}',                     -- Category-specific extras (league, venue, settlement_rules, price_target, etc.)
  status        text NOT NULL DEFAULT 'active',         -- 'active', 'resolved', 'cancelled'
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(external_source, external_ref)                 -- One canonical event per external reference
);

-- Indexes for the event matcher
CREATE INDEX IF NOT EXISTS idx_ce_category_date ON pmci.canonical_events(category, event_date);
CREATE INDEX IF NOT EXISTS idx_ce_subcategory_date ON pmci.canonical_events(subcategory, event_date);
CREATE INDEX IF NOT EXISTS idx_ce_external ON pmci.canonical_events(external_source, external_ref);
CREATE INDEX IF NOT EXISTS idx_ce_participants ON pmci.canonical_events USING gin(participants);
```

### Table: `pmci.provider_event_map`

Links a provider's event grouping to a canonical event.

```sql
CREATE TABLE IF NOT EXISTS pmci.provider_event_map (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_event_id uuid NOT NULL REFERENCES pmci.canonical_events(id),
  provider_id       smallint NOT NULL REFERENCES pmci.providers(id),
  provider_event_ref text NOT NULL,                     -- Kalshi: series_ticker; Polymarket: condition group/slug
  confidence        numeric NOT NULL DEFAULT 1.0,       -- 1.0 = schedule-anchored, <1.0 = fuzzy-matched
  match_method      text NOT NULL,                      -- 'schedule_anchor', 'team_date_match', 'title_similarity', 'manual'
  created_at        timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(provider_id, provider_event_ref)               -- Each provider event maps to exactly one canonical event
);
```

### Table: `pmci.canonical_markets`

A market-type slot within a canonical event (e.g., "moneyline", "total O/U 8.5", "spread -1.5").

```sql
CREATE TABLE IF NOT EXISTS pmci.canonical_markets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_event_id uuid NOT NULL REFERENCES pmci.canonical_events(id),
  market_template   text NOT NULL,                      -- 'moneyline', 'total', 'spread', 'btts', 'futures_winner', 'futures_award', 'yes_no', 'price_target'
  template_params   jsonb DEFAULT '{}',                 -- {line: 8.5} for totals, {spread: -1.5, team: "NYY"} for spreads, {target: 100000, asset: "BTC"} for crypto
  title             text,                               -- Canonical description: "Over/Under 8.5 Total Runs"
  created_at        timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(canonical_event_id, market_template, template_params) -- One slot per template+params per event
);

CREATE INDEX IF NOT EXISTS idx_cm_event ON pmci.canonical_markets(canonical_event_id);
CREATE INDEX IF NOT EXISTS idx_cm_template ON pmci.canonical_markets(market_template);
```

### Table: `pmci.provider_market_map`

Links a provider_market to its canonical_market slot. Two provider_market_map rows pointing to the same canonical_market from different providers = equivalent linked pair.

```sql
CREATE TABLE IF NOT EXISTS pmci.provider_market_map (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_market_id uuid NOT NULL REFERENCES pmci.canonical_markets(id),
  provider_market_id  bigint NOT NULL REFERENCES pmci.provider_markets(id),
  provider_id         smallint NOT NULL REFERENCES pmci.providers(id),
  confidence          numeric NOT NULL DEFAULT 1.0,
  match_method        text NOT NULL,                    -- 'template_exact', 'template_fuzzy', 'manual'
  status              text NOT NULL DEFAULT 'active',   -- 'active', 'removed'
  created_at          timestamptz NOT NULL DEFAULT now(),
  removed_at          timestamptz,
  removed_reason      text,
  
  UNIQUE(provider_market_id)                            -- Each provider market belongs to exactly one canonical market
);

CREATE INDEX IF NOT EXISTS idx_pmm_canonical ON pmci.provider_market_map(canonical_market_id);
CREATE INDEX IF NOT EXISTS idx_pmm_provider ON pmci.provider_market_map(provider_id);
```

### Table: `pmci.canonical_outcomes` (optional, for future use)

Tracks resolution outcomes for canonical events. Not required for Phase G linking but useful for settlement tracking.

```sql
CREATE TABLE IF NOT EXISTS pmci.canonical_outcomes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_event_id  uuid NOT NULL REFERENCES pmci.canonical_events(id),
  outcome_type        text NOT NULL,                    -- 'winner', 'total_score', 'spread_cover', 'yes', 'no'
  outcome_value       text,                             -- "Oakland Athletics", "9", "true"
  resolved_at         timestamptz,
  source              text,                             -- Where the resolution came from
  created_at          timestamptz NOT NULL DEFAULT now()
);
```

### Table: `pmci.provider_outcome_map` (optional, for future use)

```sql
CREATE TABLE IF NOT EXISTS pmci.provider_outcome_map (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_outcome_id  uuid NOT NULL REFERENCES pmci.canonical_outcomes(id),
  provider_market_id    bigint NOT NULL REFERENCES pmci.provider_markets(id),
  provider_id           smallint NOT NULL REFERENCES pmci.providers(id),
  provider_outcome_ref  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
```

## Sport Taxonomy Normalization Map

```javascript
// Static lookup for deterministic Polymarket sport codes
const POLY_SPORT_ALIAS = {
  // Hockey
  'wwoh':       'nhl',
  
  // Basketball  
  'bkfibaqeu':  'nba',        // NBA + Euroleague mixed — split by title if needed
  'basketball': 'nba',        // Generic basketball → NBA (verify via title)
  'bkjpn':      'basketball_jpn',
  'bkaba':      'basketball_aba',
  'bkbbl':      'basketball_bbl',
  'bkbsl':      'basketball_bsl',
  'bkvtb':      'basketball_vtb',
  'bkgr1':      'basketball_greece',
  'euroleague': 'euroleague',
  
  // Soccer
  'j1-100':     'soccer_j1',
  'j2-100':     'soccer_j2', 
  'ukr1':       'soccer_ukraine',
  
  // Cricket
  'cricipl':    'cricket_ipl',
  'cricpsl':    'cricket_psl',
  'cricket':    'cricket',
  
  // Junk drawer — requires title-based re-inference
  'itsb':       null,         // → inferSportFromPolymarketTitle()
};
```

## Market-Type Classifier Patterns

```javascript
// Regex patterns for Polymarket title → market_template
const MARKET_TYPE_PATTERNS = [
  // Moneyline / winner
  { pattern: /\bwinner\b\??$/i,                    template: 'moneyline' },
  { pattern: /^will .+ win\b/i,                    template: 'moneyline' },
  { pattern: /\bwill .+ beat\b/i,                  template: 'moneyline' },
  { pattern: /\bwill .+ defeat\b/i,                template: 'moneyline' },
  
  // Totals (over/under)
  { pattern: /O\/U \d+\.?\d*/i,                    template: 'total' },
  { pattern: /total (runs|goals|points|score)/i,   template: 'total' },
  { pattern: /over\/under/i,                       template: 'total' },
  
  // Spread
  { pattern: /^spread:/i,                          template: 'spread' },
  { pattern: /\(-?\d+\.5\)$/,                      template: 'spread' },
  
  // Both teams to score
  { pattern: /both teams to score/i,               template: 'btts' },
  
  // Draw
  { pattern: /end in a draw/i,                     template: 'draw' },
  
  // Futures — season/tournament winners
  { pattern: /win the 20\d{2}(-\d{2})? .*(series|championship|league|cup|trophy)/i, template: 'futures_winner' },
  { pattern: /win .*(world series|super bowl|stanley cup|champions league)/i,        template: 'futures_winner' },
  { pattern: /make the .* playoffs/i,              template: 'futures_playoff' },
  
  // Futures — awards
  { pattern: /win the 20\d{2}(-\d{2})? .*(mvp|rookie|defensive|cy young|award|trophy)/i, template: 'futures_award' },
  
  // Crypto price targets
  { pattern: /will .*(btc|eth|bitcoin|ethereum|sol|solana).* (hit|reach|above|below|over|under) \$?[\d,]+/i, template: 'price_target' },
  
  // Economics
  { pattern: /will the fed (cut|raise|hold|hike)/i, template: 'fed_rate_decision' },
  { pattern: /will .*(cpi|inflation|gdp|unemployment)/i, template: 'economic_indicator' },
  
  // Politics
  { pattern: /will .+ win the .*(election|primary|nomination|race)/i, template: 'election_winner' },
  
  // Fallback
  { pattern: /^will /i,                            template: 'yes_no' },
];
```

## External Event Source Adapters

### Sports: TheSportsDB

```
GET https://www.thesportsdb.com/api/v1/json/3/eventsround.php?id={leagueId}&r={round}&s={season}
GET https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id={leagueId}
```

League IDs: MLB=4424, NBA=4387, NHL=4380, MLS=4346, EPL=4328, La Liga=4335, Bundesliga=4331, Serie A=4332, Ligue 1=4334, Champions League=4480

Returns: `idEvent`, `strEvent`, `dateEvent`, `strTime`, `strHomeTeam`, `strAwayTeam`, `strLeague`

### Economics: Federal Reserve Calendar

```
Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
Method: HTML scrape or hardcoded calendar (8 meetings/year, dates known in advance)
```

Also: BLS release schedule at https://www.bls.gov/schedule/news_release/

### Politics: Google Civic API

```
GET https://www.googleapis.com/civicinfo/v2/elections?key={API_KEY}
```

Returns election dates, races, and jurisdictions.

### Crypto: Market-seeded

No external schedule. Canonical events are created from the first provider market seen for a given asset + price target + settlement window. The settlement date from the market metadata serves as the event date.

## Architectural Decisions

### AD-G1: Event-first matching replaces market-first matching

**Decision:** Match provider markets to canonical events (sourced from external schedules), then link markets within events by type. Do not match markets directly across providers.

**Why:** Direct market-to-market matching produced 62,832 rejected proposals at 0.001 avg confidence. The combinatorial explosion is inherent to the approach — 23K Kalshi × 13K Polymarket is 310M potential pairs. Event-first matching reduces this to O(n) lookups against a schedule of ~500-2000 canonical events.

### AD-G2: External schedules as ground truth for sports, economics, politics

**Decision:** Use TheSportsDB, Fed calendar, and Google Civic as authoritative event sources rather than deriving events from provider data.

**Why:** When Kalshi says "Athletics vs New York Yankees" and Polymarket says "A's vs New York M" (which is actually the Mets, not the Yankees), only an external schedule can resolve the ambiguity. Provider titles are marketing copy, not canonical identifiers.

### AD-G3: Crypto events are market-seeded, not schedule-anchored

**Decision:** For crypto price targets, the first provider market seen creates the canonical event. Settlement date is the anchor.

**Why:** There's no external "BTC price target schedule." The market itself defines the event. Settlement date + asset + target price is a sufficient unique key.

### AD-G4: Taxonomy normalization at ingestion time, not match time

**Decision:** Normalize Polymarket sport codes and classify market types during the ingestion pipeline, before they reach the matcher.

**Why:** Normalizing at match time means every matching run repeats the same work. Normalizing at ingestion means the data is clean once and stays clean. It also makes the `provider_markets` table directly queryable without joins or lookups.

### AD-G5: Auto-linking with a low-confidence queue (external)

**Decision:** Markets attached to the same canonical event with the same market_template are auto-linked at high confidence. Markets that match an event but below the confidence threshold are routed to a queue for LLM-based review (handled outside this plan).

**Why:** The event hierarchy makes high-confidence matching deterministic (same event + same type = same market). Human review doesn't scale past hundreds of proposals. The LLM queue handles the long tail without blocking the pipeline.

### AD-G6: Old system runs in parallel until validation complete

**Decision:** Keep the current `proposed_links` / `market_links` / `market_families` pipeline running until Phase G Step 7 validates that the new system reproduces all existing links plus new ones.

**Why:** No data loss during transition. The old system's 176 bilateral families are the regression test suite.

## Dependencies

### External Services

| Service | Purpose | Auth | Rate Limit | Cost |
|---------|---------|------|------------|------|
| TheSportsDB | Sports schedules | None (free) | Reasonable use | $0 |
| Federal Reserve calendar | FOMC dates | None (public) | N/A (static scrape) | $0 |
| BLS release schedule | CPI/jobs dates | None (public) | N/A (static scrape) | $0 |
| Google Civic API | Election dates | API key | Standard quota | $0 |
| CoinGecko API | Crypto asset data | None (free tier) | 10-30 calls/min | $0 |

### Libraries (likely needed)

- `node-fetch` or existing HTTP client for external API calls
- `cheerio` or `jsdom` for HTML scraping (Fed/BLS calendars) if not using structured data
- Existing Supabase client for DB writes

### Environment Variables (new)

- `GOOGLE_CIVIC_API_KEY` — for election calendar queries
- `THESPORTSDB_API_KEY` — optional, free tier works without key
- `COINGECKO_API_KEY` — optional, free tier works without key
