# PMCI AWS Ohio normalizer (Phase 0 Stream A)

Single Node.js process deployed on EC2 (`us-east-2`) alongside Terraform in `infra/aws-ohio/`.

## DB write policy (`scanner_informational_lag_signals`)

Stream B owns detector gates (WPA p75 × mid stability × divergence). Until those land, **this process inserts one raw placeholder row per market/source on a sampled cadence** (`PMCI_NORMALIZER_DB_SAMPLE_MS`, default **4000** ms) instead of cloning every WS delta (which would overwhelm Postgres at Kalshi throughput). Rows use `signal_strength_cents = 0`; Stream B recomputes strength from S3 envelopes or via batch queries.

Kalshi payloads are mirrored to **every** sampled tick as JSON on S3; NBA polls only write when the play-by-play JSON fingerprint changes.

## Provenance envelope (S3 + logs)

Canonical shape written to object storage:

```json
{
  "source_chain_id": "uuid",
  "observed_at": "ISO-8601",
  "market_ticker": "string",
  "payload": {}
}
```

Object key pattern: `raw/<kalshi_ws|cdn.nba.com>/<yyyy-mm-dd>/<HH>/<event_id>.json`.

## Env vars

| Var | Meaning |
|-----|---------|
| `DATABASE_URL` | Service-role Postgres (Supabase pooler ok) |
| `AWS_REGION` | Default `us-east-2` |
| `S3_BUCKET` | Default `pmci-events` |
| `SOURCE_CHAIN_KALSHI` | Default microstructure ladder UUID seeded in migration reference |
| `SOURCE_CHAIN_NBA` | Default H-2026-001 NBA chain UUID |
| `NBA_POLL_INTERVAL_MS` | Default **4000** |
| `PMCI_NORMALIZER_DB_SAMPLE_MS` | Kalshi Postgres sample throttle |
| `NBA_GAME_IDS_EXTRA` | Comma-separated NBA numeric game IDs to poll (`0022400xxx`). Required when Kalshi ticker cannot supply an ID; current `KXNBAGAME-*` slug does not encode the NBA CDN id |
| `MM_RUN_MODE` | Set **`prod`** on the host — never `demo`; keys flow through `kalshi-env` |
