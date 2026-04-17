# Phase E4: Template-Based Proposer — Schema & Architecture

## Data Models

### Migration: `provider_markets` template columns

```sql
ALTER TABLE pmci.provider_markets
  ADD COLUMN IF NOT EXISTS market_template TEXT,
  ADD COLUMN IF NOT EXISTS template_params JSONB;

CREATE INDEX IF NOT EXISTS idx_provider_markets_template
  ON pmci.provider_markets (category, market_template)
  WHERE market_template IS NOT NULL;

COMMENT ON COLUMN pmci.provider_markets.market_template IS
  'Canonical template key (e.g. btc-daily-range, fed-rate-decision). Set by rule-based classifier or LLM fallback.';
COMMENT ON COLUMN pmci.provider_markets.template_params IS
  'Structured parameters extracted from market (e.g. {"asset":"btc","date":"2026-04-14","strike":76000}).';
```

### Template vocabulary (initial)

**Crypto:**
| Template | Description | Params |
|----------|-------------|--------|
| `btc-daily-range` | Kalshi "Bitcoin price range on {date}" | `{ asset, date }` |
| `btc-daily-direction` | Polymarket "Bitcoin Up or Down on {date}" | `{ asset, date }` |
| `btc-price-threshold` | "Will BTC be above/below $X on {date}" | `{ asset, date, strike, direction }` |
| `btc-price-dip` | "Will Bitcoin dip to $X on {date}" | `{ asset, date, strike }` |
| `btc-interval` | Polymarket 5-min interval "BTC Up or Down - {datetime}" | `{ asset, datetime_start, interval_minutes }` |
| `btc-milestone` | "Will BTC hit $X by {date}" / "BTC all time high" | `{ asset, strike, deadline }` |
| `crypto-comparative` | "Will BTC or ETH reach ATH first?" | `{ assets[] }` |
| `crypto-corporate` | "Will MicroStrategy purchase more Bitcoin" | `{ company, asset }` |
| `eth-*` / `sol-*` | Same patterns as btc-* for other assets | same |

**Economics:**
| Template | Description | Params |
|----------|-------------|--------|
| `fed-rate-decision` | "Will the Fed {hike/cut/hold} by {bps} at {meeting}" | `{ action, bps, meeting_date }` |
| `fed-rate-direction` | "Will the Fed increase/decrease rates after {meeting}" | `{ direction, meeting_date }` |
| `fed-rate-sequence` | "Will the Fed Pause-Cut-Cut in next three decisions" | `{ sequence[], meetings[] }` |
| `fed-personnel` | "Will {person} be confirmed/leave as Fed Chair" | `{ person, role, action }` |
| `fed-dissent` | "Will {N} people dissent the {meeting} decision" | `{ count, meeting_date }` |
| `fomc-specific` | "Will the {month} FOMC result in {outcome}" | `{ meeting_date, outcome_type }` |

### Template compatibility matrix

```
COMPATIBLE PAIRS (cross-provider):
  btc-daily-range     ↔ btc-daily-direction    WHERE date matches
  btc-price-threshold ↔ btc-price-threshold    WHERE asset + date + strike range match
  btc-price-threshold ↔ btc-price-dip          WHERE asset + date + strike range match
  fed-rate-decision   ↔ fed-rate-decision       WHERE meeting_date matches
  fed-rate-decision   ↔ fed-rate-direction      WHERE meeting_date matches
  fed-rate-decision   ↔ fomc-specific           WHERE meeting_date matches

NEVER COMPATIBLE:
  btc-interval        ↔ anything (5-min intervals have no Kalshi equivalent)
  btc-milestone       ↔ btc-daily-* (different time horizons)
  crypto-corporate    ↔ btc-* (different question types)
  fed-personnel       ↔ fed-rate-* (different question domains)
  fed-rate-sequence   ↔ fed-rate-decision (multi-meeting vs single-meeting)
```

## API Contracts

No new API endpoints. Template data flows through existing proposer → auto-accept → audit pipeline.

New npm scripts:
- `pmci:classify:templates` — backfill + ongoing classification
- No changes to `pmci:review:crypto` or `pmci:review:economics` (same entry points, improved internals)

### Classifier module interface

```typescript
// lib/matching/templates/crypto-templates.mjs
export function classifyTemplate(market: {
  title: string;
  provider_market_ref?: string;
  provider_id: number;
  category: string;
}): { template: string; params: Record<string, any> } | null;

// lib/matching/templates/llm-classifier.mjs
export async function classifyBatch(markets: Array<{
  id: number;
  title: string;
  category: string;
}>): Promise<Array<{ id: number; template: string; params: Record<string, any> }>>;

// lib/matching/templates/compatibility-rules.mjs
export function areTemplatesCompatible(
  templateA: string, paramsA: Record<string, any>,
  templateB: string, paramsB: Record<string, any>
): { compatible: boolean; reason: string };
```

## Architectural Decisions

**Why templates over embeddings:** The `idx_pmci_provider_markets_embedding` pgvector index already exists but is unused. Embeddings would solve the same problem (semantic similarity > string similarity) but are harder to debug, explain, and enforce strict compatibility rules on. Templates give deterministic, auditable matching with zero ongoing compute cost. Embeddings remain available as a future scoring signal within template-compatible pairs.

**Why rule-based first, LLM fallback:** Provider market title patterns are highly repetitive — Kalshi has ~20 title templates across all categories, Polymarket ~30. A regex/rule classifier handles 90%+ of markets. The LLM fallback exists for genuinely novel patterns and to bootstrap the template vocabulary for new categories (Phase F+). Over time the rule-based share increases as new patterns are added.

**Why classify at ingest time:** Markets only need classification once. Doing it at ingest means the proposer never sees unclassified markets. The `PMCI_CLASSIFY_ON_INGEST` flag exists for safety — disable if classification is causing ingest latency, and rely on periodic backfill instead.

**Why `template_params` is JSONB, not separate columns:** Different templates have different parameter shapes. A `btc-daily-range` has `{ asset, date }` while `fed-rate-decision` has `{ action, bps, meeting_date }`. JSONB avoids schema changes per template type and supports the compatibility rules engine cleanly.

## Dependencies

- `@anthropic-ai/sdk` — for Haiku classifier (likely already installed or trivial to add)
- `ANTHROPIC_API_KEY` env var on Fly.io (for Haiku fallback in production)
- No new external services or infrastructure
