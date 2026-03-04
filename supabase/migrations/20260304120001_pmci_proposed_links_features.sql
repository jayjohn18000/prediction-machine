-- PMCI Phase 2: add machine-readable features vector to proposed_links

alter table pmci.proposed_links
  add column if not exists features jsonb;

