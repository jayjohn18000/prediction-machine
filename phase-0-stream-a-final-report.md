## Phase 0 Stream A — final report

- **Branch:** `phase-0/stream-a-schema-normalizer`
- **HEAD SHA:** `8f05e1f065ec424626a3b01db7c1b28afc384860`
- **Tracked vs `origin/main` (newest-first):**

```
8f05e1f docs(phase-0): correct final-report HEAD SHA
c6c9730 docs(phase-0): capture Stream A SQL validation outputs
e90d187 feat(infra): Terraform Ohio VPC + EC2 normalizer bootstrap
7ee9c9a feat(pmci-normalizer): Stream A provenance ingest (Kalshi PROD WS + NBA CDN)
d9988a2 chore(deps): add @aws-sdk/client-s3 for pmci-normalizer uploads
4a58e0f chore(validation): extend verify-pmci-schema for Phase 0 scanner/MM tables
ce0ef5a feat(mm): populate mm_fills.entry_price + was_maker on insert
72c7b16 feat(db): MM v1 state tables + mm_fills ledger extensions
c6c5384 feat(db): Phase 0 scanner hypotheses, signal tables, backtest scaffolding
1963f12 feat(db): Phase 0 scanner reference tables + inefficiency enum
fc64b6f chore(phase-0): commit Phase 0 planning docs
```

### Migrations

| File | Purpose |
|------|---------|
| `supabase/migrations/20260509120000_pmci_scanner_reference.sql` | `source_chains`, `measured_variables`, `pmci.inefficiency_type` enum + Phase 0 seeds |
| `supabase/migrations/20260509120100_pmci_scanner_core.sql` | Hypotheses, six `scanner_*` tables + compositor/allocator/decay/backtest DDL, `scanner_signals_unified` view, alerts + `enforce_alerts_live_only` trigger |
| `supabase/migrations/20260509120200_pmci_mm_v1_redesign.sql` | `mm_vpin_state`, `mm_protection_state`, `mm_gm_posterior_state`; `mm_orders` / `mm_pnl_snapshots` / `mm_market_config` extensions; four new `mm_fills` ledger columns + backfills |

### `pmci.market_outcomes` join (migration 3 backfill — actual columns)

Backfill keyed on **`provider_market_id`** (FK to `pmci.provider_markets.id`, same as **`mm_fills.market_id`**). Canonical columns used:

- **`winning_outcome`** (`text`)
- **`resolved_at`** (`timestamptz`)

Binary normalization maps common literals (`yes`/`y`/`1`, `no`/`n`/`0`). Non-matching `winning_outcome` values coerce to **`settlement_outcome = 'no_settle'`** with **`settled_value` NULL** until spec tightens contract typing.

*(Post-ingest observation: **`UPDATE … FROM pmci.market_outcomes`** touched **0** rows at migrate time — no ledger overlap with populated outcomes snapshot yet.)*

### `npm run verify:schema` (tail — exit **0**)

```
PMCI schema verification: PASS
  - Schema pmci exists
  - Required tables present: 47
  - Required columns present for market_links, provider_markets, provider_market_snapshots
  - View pmci.v_market_links_current exists
```

### Operational notes

1. **`supabase db push`:** fails against this Supabase remote because **`schema_migrations.version` timestamps drift** vs local filenames (historic renames — see `phase-0-stream-a-validation.md`). DDL was applied safely via **`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f`** for each migration, then versions **`20260509120000` / `20260509120100` / `20260509120200`** inserted into **`supabase_migrations.schema_migrations`**.
2. **AWS ingest:** workstation lacks **`terraform` + `aws` CLIs** — **EC2 provisioning, Session Manager systemd check, recursive S3 `raw/` ≥100 keys, and 30‑minute per-`source_chain_id` Postgres counts did not execute here.**

### Normalize / ingest placeholders (Kalshi WS + NBA CDN)

- **Chosen policy (documented in `pmci-normalizer/README.md`):** insert **`scanner_informational_lag_signals` rows at `signal_strength_cents = 0`** on the Kalshi Postgres **sample throttle** (`PMCI_NORMALIZER_DB_SAMPLE_MS`, default 4000 ms); Stream B derives real gates downstream. NBA CDN payloads only advance when **`sha256(playbyplay.json)` digest changes**.
- **Source-chain UUIDs (migration seeds):**
  - **Kalshi / micro ladder:** `cccc3333-e89b-12d3-a456-426614174002`
  - **NBA H-2026-001 ladder:** `aaaa1111-e89b-12d3-a456-426614174000`

### Thirty-minute ingestion window verification (immediate post-DDL baseline)

Because the normalizer was **not deployed in this workspace**, Postgres evidence is currently empty:

```
SELECT COUNT(*) FROM pmci.scanner_informational_lag_signals WHERE observed_at > NOW() - INTERVAL '30 minutes';
→ 0
```

**(Expected non-zero envelope mix after EC2 systemd start):** **`kalshi_ws`** from sampled book traffic + **`cdn.nba.com`** only when `NBA_GAME_IDS_EXTRA` or `NBA_AUTODISCOVER_GAME_IDS=1` yields live game IDs.)

### Alerts trigger smoke (verbatim)

```
ERROR:  alerts can only reference hypotheses with status=live, got <NULL>
CONTEXT:  PL/pgSQL function pmci.enforce_alerts_live_only() line 6 at RAISE
```

### Ledger spot checks (`mm_fills`)

```
entry_price populated:       787
was_maker non-null subset:    323
```

*(Pre fee-tracking fills remain **`was_maker` NULL**, matching the Stream A spec.)*

### EC2 / SSM status

- **`aws ec2 describe-instances`** — **not executed (no AWS CLI)**.
- **`pmci-normalizer.service`** — **not verified on a host.**

### Status line for downstream Streams B / C / E / F

**`BLOCKED ON: AWS Ohio apply + Session Manager systemd verification + ≥30 min Kalshi/NBA ingestion soak`** — **schema migrations, ledger forward-writes (`entry_price`, `was_maker`), ingestion code, IaC scaffolding, validation notes, and branch push are complete for operator follow-through.**
