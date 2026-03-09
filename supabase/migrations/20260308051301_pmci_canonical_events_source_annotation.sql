-- D8 — Add source_annotation used by PMCI probe poly_only guardrails
ALTER TABLE pmci.canonical_events
  ADD COLUMN IF NOT EXISTS source_annotation text;

-- Safe default for legacy rows and future inserts
UPDATE pmci.canonical_events
SET source_annotation = 'unknown'
WHERE source_annotation IS NULL;

ALTER TABLE pmci.canonical_events
  ALTER COLUMN source_annotation SET DEFAULT 'unknown';

-- Optional index for probe/filter performance
CREATE INDEX IF NOT EXISTS idx_pmci_canonical_events_source_annotation
  ON pmci.canonical_events(source_annotation);

COMMENT ON COLUMN pmci.canonical_events.source_annotation IS
  'Canonical event source label used by PMCI diagnostics (e.g., poly_only, unknown).';
