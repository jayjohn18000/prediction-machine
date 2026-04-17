-- Phase E4: template-based proposer — structural classification on provider_markets
ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS market_template TEXT,
  ADD COLUMN IF NOT EXISTS template_params JSONB;

CREATE INDEX IF NOT EXISTS idx_provider_markets_template
  ON pmci.provider_markets (category, market_template)
  WHERE market_template IS NOT NULL;

COMMENT ON COLUMN pmci.provider_markets.market_template IS
  'Canonical template key (e.g. btc-daily-range, fed-rate-decision). Set by rule-based classifier or LLM fallback.';
COMMENT ON COLUMN pmci.provider_markets.template_params IS
  'Structured parameters extracted from market (e.g. {"asset":"btc","date":"2026-04-14","strike":76000}).';
