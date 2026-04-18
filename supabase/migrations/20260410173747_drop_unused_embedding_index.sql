-- Baseline: applied on remote via dashboard; aligns local migrations with supabase_migrations.
-- Drops ivfflat index (see 20260307000001_pgvector_embeddings.sql); embedding column may remain unused.
DROP INDEX IF EXISTS idx_pmci_provider_markets_embedding;
