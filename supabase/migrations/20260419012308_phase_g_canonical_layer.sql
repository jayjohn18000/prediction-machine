-- Phase G: canonical event layer — extend pmci tables + add provider_event_map / provider_market_map.
-- Alters in place; keeps slug/lifecycle/start_time for existing PMCI code paths.

-- --- pmci.canonical_events: schedule anchors & participants ---
ALTER TABLE pmci.canonical_events
  ADD COLUMN IF NOT EXISTS subcategory text,
  ADD COLUMN IF NOT EXISTS event_date date,
  ADD COLUMN IF NOT EXISTS event_time timestamptz,
  ADD COLUMN IF NOT EXISTS participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS external_source text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

COMMENT ON COLUMN pmci.canonical_events.subcategory IS 'Phase G: mlb, nba, fomc, btc_price, senate_race, …';
COMMENT ON COLUMN pmci.canonical_events.event_date IS 'Phase G: primary occurrence / resolution calendar date';
COMMENT ON COLUMN pmci.canonical_events.event_time IS 'Phase G: kickoff / release instant when known';
COMMENT ON COLUMN pmci.canonical_events.participants IS 'Phase G: [{name, role}, …]';
COMMENT ON COLUMN pmci.canonical_events.external_ref IS 'Phase G: TheSportsDB id, FOMC id, election id, …';
COMMENT ON COLUMN pmci.canonical_events.external_source IS 'Phase G: thesportsdb, fed_calendar, google_civic, coingecko, market_seeded';
COMMENT ON COLUMN pmci.canonical_events.resolved_at IS 'Phase G: when the real-world outcome was known';

-- Backfill event_date from legacy start_time where possible
UPDATE pmci.canonical_events
SET event_date = (start_time AT TIME ZONE 'UTC')::date
WHERE event_date IS NULL AND start_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ce_category_date ON pmci.canonical_events (category, event_date);
CREATE INDEX IF NOT EXISTS idx_ce_subcategory_date ON pmci.canonical_events (subcategory, event_date);
CREATE INDEX IF NOT EXISTS idx_ce_external ON pmci.canonical_events (external_source, external_ref);
CREATE INDEX IF NOT EXISTS idx_ce_participants ON pmci.canonical_events USING gin (participants);

CREATE UNIQUE INDEX IF NOT EXISTS ux_ce_external_source_ref
  ON pmci.canonical_events (external_source, external_ref)
  WHERE external_source IS NOT NULL AND external_ref IS NOT NULL;

-- --- pmci.canonical_markets: market_template slots (Phase G) ---
ALTER TABLE pmci.canonical_markets
  ADD COLUMN IF NOT EXISTS market_template text,
  ADD COLUMN IF NOT EXISTS template_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS title text;

COMMENT ON COLUMN pmci.canonical_markets.market_template IS 'Phase G: moneyline, total, spread, … (aligns with provider market_template vocabulary where possible)';
COMMENT ON COLUMN pmci.canonical_markets.template_params IS 'Phase G: line, spread, asset, …';
COMMENT ON COLUMN pmci.canonical_markets.title IS 'Phase G: human slot label';

CREATE INDEX IF NOT EXISTS idx_cm_template ON pmci.canonical_markets (market_template);

CREATE UNIQUE INDEX IF NOT EXISTS ux_cm_event_template_params
  ON pmci.canonical_markets (canonical_event_id, market_template, template_params)
  WHERE market_template IS NOT NULL;

-- --- Provider ↔ canonical event ---
CREATE TABLE IF NOT EXISTS pmci.provider_event_map (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_event_id uuid NOT NULL REFERENCES pmci.canonical_events (id) ON DELETE CASCADE,
  provider_id smallint NOT NULL REFERENCES pmci.providers (id),
  provider_event_ref text NOT NULL,
  confidence numeric NOT NULL DEFAULT 1.0,
  match_method text NOT NULL DEFAULT 'schedule_anchor',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_event_ref)
);

CREATE INDEX IF NOT EXISTS idx_pem_canonical ON pmci.provider_event_map (canonical_event_id);
CREATE INDEX IF NOT EXISTS idx_pem_provider ON pmci.provider_event_map (provider_id);

COMMENT ON TABLE pmci.provider_event_map IS 'Phase G: Kalshi series / Polymarket condition group → canonical_events';
COMMENT ON COLUMN pmci.provider_event_map.provider_event_ref IS 'Kalshi: series_ticker; Polymarket: event slug or group id';

-- --- Provider market ↔ canonical_market slot ---
CREATE TABLE IF NOT EXISTS pmci.provider_market_map (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_market_id uuid NOT NULL REFERENCES pmci.canonical_markets (id) ON DELETE CASCADE,
  provider_market_id bigint NOT NULL REFERENCES pmci.provider_markets (id) ON DELETE CASCADE,
  provider_id smallint NOT NULL REFERENCES pmci.providers (id),
  confidence numeric NOT NULL DEFAULT 1.0,
  match_method text NOT NULL DEFAULT 'template_exact',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_reason text,
  UNIQUE (provider_market_id)
);

CREATE INDEX IF NOT EXISTS idx_pmm_canonical ON pmci.provider_market_map (canonical_market_id);
CREATE INDEX IF NOT EXISTS idx_pmm_provider ON pmci.provider_market_map (provider_id);

COMMENT ON TABLE pmci.provider_market_map IS 'Phase G: provider_markets row → canonical_markets slot; same canonical_market_id across providers = linked';
