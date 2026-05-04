-- Rotator blocklist: encoding bugs, high reject rates, manual holds (ADR-013 selection hygiene).

CREATE TABLE pmci.mm_ticker_blocklist (
  ticker text PRIMARY KEY,
  reason text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  rejected_count integer,
  notes text
);

COMMENT ON TABLE pmci.mm_ticker_blocklist IS
  'Time-bounded MM rotator exclusions; queried by rotate-demo-tickers before scoring. Service-role only.';

CREATE INDEX idx_mm_ticker_blocklist_expires ON pmci.mm_ticker_blocklist (expires_at);

INSERT INTO pmci.mm_ticker_blocklist (ticker, reason, expires_at, notes)
VALUES (
  'KXLCPIMAXYOY-27-P4.5',
  'encoding_bug',
  now() + interval '7 days',
  'scalar-strike -P4.5 dot pattern; sanitize fix 2026-05-03 incomplete; Kalshi PROD still rejects'
)
ON CONFLICT (ticker) DO NOTHING;

REVOKE ALL ON pmci.mm_ticker_blocklist FROM PUBLIC;
REVOKE ALL ON pmci.mm_ticker_blocklist FROM anon;
REVOKE ALL ON pmci.mm_ticker_blocklist FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON pmci.mm_ticker_blocklist TO service_role, postgres;
