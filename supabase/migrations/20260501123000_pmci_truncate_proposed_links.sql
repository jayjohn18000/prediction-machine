-- Track B.B.4 — Arb-era proposal queue archival (see docs/archive/pivot-2026-04/data/proposed_links_2026-05-01.csv.gz).
-- Pre-flight: archive row count MUST match live count at export time. Does NOT drop table.
-- FK: pmci.review_decisions references proposed_links — CASCADE clears dependent review rows.
TRUNCATE pmci.proposed_links CASCADE;
