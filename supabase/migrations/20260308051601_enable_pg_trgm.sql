-- D8.1 — Enable pg_trgm for similarity() used by PMCI probe diagnostics
CREATE EXTENSION IF NOT EXISTS pg_trgm;
