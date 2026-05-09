## Phase 0 Stream C — final report

### Branch

- **`phase-0/stream-c-decay-monitor`** — forked from **`phase-0/stream-a-schema-normalizer`** at **`0043c6bad`** (`HEAD` before Stream C commits).

### Commits (this Stream)

```
34de5deb3a83777609caa371b2a07d35a57861f0 feat(scanner): Stream C nightly decay monitor (PSI/KS, KSWIN, logistic FI)
f0822223382317a0317652975f06a604e817e553 docs(phase-0): Stream C final report
```

### What shipped

| Area | Details |
|------|---------|
| **Libs** | `lib/scanner/decay/{psi,ks,kswin,feature-importance,signal-features,run-decay-core}.mjs` |
| **Orchestrator** | `scripts/scanner/run-decay-cron.mjs` → `runDecayMonitorCron(pg)` |
| **Admin route** | `POST /v1/admin/jobs/scanner-decay-nightly` (in-process; Pattern 4 visibility via HTTP status) |
| **Edge Function** | `supabase/functions/pmci-job-runner/index.ts` — `JOB_MAP["pmci-scanner-decay-nightly"]` → `/v1/admin/jobs/scanner-decay-nightly` |
| **Migration** | `supabase/migrations/20260509143000_pmci_scanner_decay_cron.sql` — pg_cron **`pmci-scanner-decay-nightly`**, **`30 3 * * *`** (03:30 UTC), body `{"job":"pmci-scanner-decay-nightly"}` via `net.http_post` + Vault-backed `_job_runner_url` / `_job_runner_headers` |
| **Tests** | `tests/scanner/decay/*.test.mjs` + `tests/scanner/decay/test-kswin-synthetic.mjs`; CI wired via root **`npm test`** (extends globs + synthetic file) |

**Implementation notes**

- **KSWIN on `{0,1}` correctness bits**: asymptotic two-sample KS p-values collapse toward ~1 on discrete streams; the detector uses a **permutation KS p-value** when samples are strictly binary, preserving River-style `p ≤ alpha ∧ D > 0.1` semantics without scipy.
- **Drift rows**: `weighted_drift` / PSI paths operate on resolved **`hit` / `miss`** rows (`correctnessBit`); other outcomes are skipped for PSI/KSWIN streams.

### Verification — automated

Command:

```bash
npm run lint:poly-write-guard && node --test tests/scanner/decay/*.test.mjs tests/scanner/decay/test-kswin-synthetic.mjs
```

Result: **7 files / 7 tests passed**, including synthetic Bernoulli shift **KSWIN fires**.

Full-repo `npm test` still reports unrelated historical failures (live Polygon RPC 401, live PMCI route flakes); Stream C slice is green.

### Verification — Pattern 4 (encoded in migration)

After migration applies and cron has fired at least once:

```sql
SELECT count(*) AS decay_rows_24h
FROM pmci.hypothesis_decay_state
WHERE computed_at > now() - interval '24 hours';
```

Manual trigger sanity (~5 minutes):

```sql
SELECT count(*), bool_or(triggers_retire)
FROM pmci.hypothesis_decay_state
WHERE computed_at > now() - interval '5 minutes';
```

### Verification — operator runtime (executed / blocked)

| Step | Result |
|------|--------|
| **`supabase db push`** | **Blocked:** CLI reports remote migration history not matching local tree (`Remote migration versions not found…`). Needs **`supabase migration repair`** / **`supabase db pull`** alignment per CLI hint before this cron migration can apply cleanly. |
| **First cron-equivalent run** | **Executed locally:** `node scripts/scanner/run-decay-cron.mjs` against `.env` `DATABASE_URL` returned **`hypothesesConsidered: 0`**, **`decayRowsWritten: 0`** — no `live`/`testing` hypotheses present, so **no `hypothesis_decay_state` rows** yet (expected until hypotheses exist). |
| **Edge Function HTTP smoke** | **Not executed** (would require invoking deployed Supabase Function + Fly `pmci-api` with secrets). |
| **24 h observation** | **Not executed** in-session — operator should capture **`decay_rows_24h`** after one nightly cycle post-deploy. |
| **`feature_importance` UPDATE path** | **Unit-tested** (`computeFeatureImportanceFit`); **DB-level smoke pending** seeded hypothesis + ≥50 resolved rows per lane (FK-heavy seed intentionally deferred here). |

### Ops checklist

1. Repair migration drift → **`supabase db push`** (apply `20260509143000_pmci_scanner_decay_cron.sql`).
2. Deploy **`pmci-api`** (Fastify route must exist before cron fires).
3. Redeploy **`pmci-job-runner`** Edge Function so **`JOB_MAP`** includes **`pmci-scanner-decay-nightly`**.
4. Seed or promote at least one hypothesis to **`live`** or **`testing`** → rerun **`runDecayMonitorCron`** → confirm Pattern 4 SELECTs return **`≥ 1`** row.

### Git remote

```bash
git push -u origin phase-0/stream-c-decay-monitor
```

*(Confirm remote tip matches **`f0822223382317a0317652975f06a604e817e553`** after push.)*

### Operator stash notice

Unrelated Phase 0 / Stream B work was **`git stash push`**’d as **`wip-before-stream-c-checkout`** before rebasing this branch onto Stream A. Recover with `git stash list` / `git stash pop` **after** switching back to the appropriate branch.

### Final status line

**`BLOCKED ON: Supabase migration-history drift (db push); Fly pmci-api + Edge Function redeploy; seeded live/testing hypotheses for Pattern 4 row-count smoke & feature-importance DB verification`** — **implementation + report committed on `phase-0/stream-c-decay-monitor` (tip `f0822223382317a0317652975f06a604e817e553`).**
