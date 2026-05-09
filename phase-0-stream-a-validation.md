## Phase 0 Stream A — post-migrate validation snapshots

Captured **2026-05-09** after applying:

- `supabase/migrations/20260509120000_pmci_scanner_reference.sql`
- `supabase/migrations/20260509120100_pmci_scanner_core.sql`
- `supabase/migrations/20260509120200_pmci_mm_v1_redesign.sql`

**Note:** `supabase db push` reports remote migration-history skew vs local timestamps (historic operator-side renames). Migrations were applied with `psql "$DATABASE_URL" -f …` and registered in `supabase_migrations.schema_migrations` for versions `20260509120000`, `20260509120100`, `20260509120200`.

### `information_schema` spot checks

```sql
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_schema='pmci' AND table_name LIKE 'scanner\_%' ESCAPE '\'
   AND table_type='BASE TABLE';
```
→ **expect 6** (the unified view lives in `information_schema.views`).

`mm_orders` mode/hypothesis_id columns → count **2**  
`mm_fills` new settlement columns → count **4**

### Seeds

```
measured_vars|5
source_chains|3
```

### `mm_fills` backfills (post UPDATE)

```
fills_entry_nn|787
fills_was_maker_nn|323
```

### Alerts live-only trigger (negative smoke)

Attempt:

```sql
INSERT INTO pmci.alerts (hypothesis_id, signal_id, signal_type, message, webhook_target, tradable)
VALUES ('H-NONEXIST','00000000-0000-0000-0000-000000000000'::uuid,'test','test','test',false);
```

Captured error:

```
ERROR:  alerts can only reference hypotheses with status=live, got <NULL>
CONTEXT:  PL/pgSQL function pmci.enforce_alerts_live_only() line 6 at RAISE
```

### Scanner signal rows — last 30 minutes window

Immediately after DDL (no ingest yet):

```
0
```

(Expect non-zero once `pmci-normalizer` runs in AWS or locally with valid Kalshi credentials.)

### `npm run verify:schema`

Tail:

```
PMCI schema verification: PASS
  - Schema pmci exists
  - Required tables present: 47
  - Required columns present for market_links, provider_markets, provider_market_snapshots
  - View pmci.v_market_links_current exists
```

### AWS / Terraform / 30‑minute soak

Blocked in this sandbox: **`aws` and `terraform` CLIs unavailable** locally; EC2 provisioning, SSM status, S3 recursive object counts ≥100, and 30‑minute row counts **not executed here** — tracked in final report as operator follow-up.
