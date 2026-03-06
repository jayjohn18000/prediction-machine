CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS title_embedding vector(1536);

CREATE INDEX IF NOT EXISTS idx_pmci_provider_markets_embedding
  ON pmci.provider_markets
  USING ivfflat (title_embedding vector_cosine_ops)
  WITH (lists = 100);

