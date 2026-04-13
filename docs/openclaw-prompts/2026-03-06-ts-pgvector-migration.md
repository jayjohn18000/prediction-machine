# OpenClaw Prompt: TypeScript Migration + pgvector Semantic Matching
> Generated: 2026-03-06
> Executor: OpenClaw (Plumbo) | Orchestrator: Claude Cowork

## Context

The current proposal engine (`lib/matching/proposal-engine.mjs`) is entirely rule-based — Jaccard similarity on titles, slug parsing, last-name extraction. It produces 162 rejections to 9 acceptances (5.5% acceptance rate). The root cause is brittle string matching that can't handle paraphrased titles across Kalshi and Polymarket (e.g. "Will Donald Trump win?" vs "2028 Presidential — Trump").

Before expanding from politics → all markets (sports, crypto, elections globally), two things need to happen:
1. **TypeScript migration** — new market adapters without type contracts will break silently at runtime. The Zod schemas already exist; converting to TS is mostly renaming + inferring types.
2. **pgvector semantic matching** — replace Jaccard title similarity with cosine similarity on OpenAI embeddings, dramatically improving proposal acceptance rate and enabling ANN retrieval instead of O(N²) blocking.

**Ordering:** TS migration (src/ + lib/ only) → pgvector → expand to sports/crypto.

---

## Phase 1: TypeScript Migration (src/ + lib/ only)

### Approach
- `allowJs: true` in tsconfig — scripts stay as `.mjs` for now, migrated last
- Convert `src/` and `lib/` (~15 files) to `.ts` first — these are the core logic imported by everything
- Use `z.infer<typeof schema>` to derive types from existing Zod validators (free types, no duplication)

### Files to convert (in order)
```
src/platform/env.mjs       → env.ts
src/db.mjs                 → db.ts         (add DbRow generic, typed query<T>())
lib/providers/kalshi.mjs   → kalshi.ts     (KalshiMarket interface)
lib/providers/polymarket.mjs → polymarket.ts (PolymarketMarket interface)
lib/pmci-matching-adapters.mjs → pmci-matching-adapters.ts (MatchingFields interface)
lib/ingestion/universe.mjs → universe.ts
lib/pmci-ingestion.mjs     → pmci-ingestion.ts
lib/matching/proposal-engine.mjs → proposal-engine.ts
src/routes/*.mjs           → *.ts
src/api.mjs                → api.ts
```

### tsconfig.json (root)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowJs": true,
    "strict": true,
    "outDir": "dist/",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src/**/*", "lib/**/*"],
  "exclude": ["scripts/**", "node_modules"]
}
```

### Key new types to define
```typescript
// lib/types.ts (new shared types file)
export interface ProviderMarket {
  id: number;
  provider_id: number;
  provider_market_ref: string;
  event_ref: string | null;
  title: string;
  category: string | null;
  status: string;
  metadata: Record<string, unknown>;
  title_embedding: number[] | null; // vector(1536) — added in Phase 2
}

export interface MatchingFields {
  template: string;
  jurisdiction: string | null;
  cycle: number | null;
  party: string | null;
  candidateName: string | null;
  resolutionYear: number | null;
}

export interface ProposedLink {
  kalshi_market_id: number;
  poly_market_id: number;
  relationship_type: 'equivalent' | 'proxy' | 'correlated';
  confidence: number;
  features: LinkFeatures;
}

export interface LinkFeatures {
  title_jaccard: number;
  entity_overlap: number;
  date_delta_days: number | null;
  outcome_name_match: number;
  embedding_cosine_similarity: number | null; // added in Phase 2
  confidence_raw: number;
  template: string;
}
```

### Package changes
```bash
npm install -D typescript tsx @types/node @types/pg
```
- Scripts use `tsx` for development; production builds via `tsc`
- No changes to runtime dependencies

---

## Phase 2: pgvector Semantic Matching

### 2a. Enable pgvector in Supabase

New migration: `supabase/migrations/20260307000001_pgvector_embeddings.sql`
```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE pmci.provider_markets
  ADD COLUMN title_embedding vector(1536);

CREATE INDEX idx_pmci_provider_markets_embedding
  ON pmci.provider_markets
  USING ivfflat (title_embedding vector_cosine_ops)
  WITH (lists = 100);
```

### 2b. Embedding service

New file: `lib/embeddings.ts`
```typescript
import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const cache = new Map<string, number[]>();

export async function embed(text: string): Promise<number[]> {
  if (cache.has(text)) return cache.get(text)!;
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',  // 1536 dims, $0.02/1M tokens
    input: text,
  });
  const vec = res.data[0].embedding;
  cache.set(text, vec);
  return vec;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return res.data.map(d => d.embedding);
}
```

**Model choice:** `text-embedding-3-small` (1536 dims) — $0.02/1M tokens, sufficient for short market titles.

**New env var:** `OPENAI_API_KEY` — add to `.env.example`

### 2c. Backfill existing markets

New script: `scripts/backfill-embeddings.mjs`
- Fetch all provider_markets with null title_embedding
- Batch by 100, call embedBatch(), UPDATE rows
- Estimated: ~2,814 markets / 100 = 29 API calls (~$0.001 total cost)

### 2d. Update ingestion to embed at ingest time

In `lib/pmci-ingestion.ts`, `ingestProviderMarket()`:
- After upsert, check if title changed (compare returned row)
- If new or title changed: call `embed(market.title)`, then `UPDATE ... SET title_embedding = $1 WHERE id = $2`
- This keeps embeddings fresh with no separate job

### 2e. Update proposal engine — replace Jaccard with ANN retrieval

**Current flow (O(N²)):**
1. Load all markets → Block by topic signature → Score all pairs within block

**New flow:**
1. Load all markets
2. For each Kalshi market, use pgvector ANN query to fetch top-20 Polymarket candidates by cosine similarity
3. Score only those 20 candidates with existing logic + add embedding score

**New DB query in proposal-engine.ts:**
```sql
SELECT
  pm.id,
  pm.title,
  pm.provider_market_ref,
  pm.metadata,
  1 - (pm.title_embedding <=> $1::vector) AS cosine_sim
FROM pmci.provider_markets pm
WHERE pm.provider_id = $2          -- cross-provider only
  AND pm.status = 'active'
  AND pm.title_embedding IS NOT NULL
ORDER BY pm.title_embedding <=> $1::vector
LIMIT 20;
```

**Updated scoring weights:**
```
// Current:
score = 0.40 * title_jaccard + 0.30 * slug_similarity + 0.30 * entity_match

// New:
score = 0.25 * title_jaccard + 0.20 * slug_similarity + 0.25 * entity_match + 0.30 * embedding_cosine
```

**Fallback:** If a market has no embedding yet, fall back to current pure Jaccard scoring.

### 2f. Log embedding score in features

Add `embedding_cosine_similarity` to `proposed_links.features` JSONB for audit trail.

---

## Phase 3: Expand to Sports + Crypto (entry criteria)

Only begin after:
- [ ] TS migration complete, `tsc --noEmit` passes with 0 errors in src/ + lib/
- [ ] pgvector backfill complete, all 2,814 markets have embeddings
- [ ] Proposal acceptance rate > 20% on a fresh politics run (validate improvement)
- [ ] New market adapters (Kalshi sports series, Polymarket crypto) typed from day one

---

## Critical Files

| File | Role |
|---|---|
| `lib/matching/proposal-engine.mjs` | Core matching logic — all scoring changes go here |
| `lib/pmci-ingestion.mjs` | Ingestion — add embedding generation on upsert |
| `lib/embeddings.ts` | New — embedding service with in-process cache |
| `supabase/migrations/20260307000001_pgvector_embeddings.sql` | New — vector extension + column + index |
| `scripts/backfill-embeddings.mjs` | New — one-time backfill of existing markets |
| `lib/types.ts` | New — shared interfaces (ProviderMarket, LinkFeatures, etc.) |
| `.env.example` | Add OPENAI_API_KEY |

---

## Verification

```bash
# 1. Install TS deps
npm install -D typescript tsx @types/node @types/pg

# 2. Confirm pgvector installed after migration
npm run verify:schema    # should show title_embedding column

# 3. Run backfill
node scripts/backfill-embeddings.mjs
# Expected: "Embedded 2814 markets in 29 batches"

# 4. Run TypeScript check
npx tsc --noEmit
# Expected: 0 errors

# 5. Run proposal cycle and compare acceptance rate
npm run pmci:propose:politics
npm run pmci:check:proposals
# Expected: acceptance rate > 20% (up from 5.5%)

# 6. Smoke test API still healthy
npm run pmci:smoke
npm run pmci:watch
```
