# PMCI Politics Validation Run

**Timestamp of run:** 2026-02-28 (UTC ~05:02)

**Environment assumptions:**
- Base URL: `http://localhost:8787`
- Lag threshold: `PMCI_MAX_LAG_SECONDS` = 120 (default)
- API: `npm run api:pmci` (src/api.mjs). Observer was not run during this run; data pre-existing.

**Note on observer:** The observer is designed to run **semi-autonomously**: once started (`npm run start`), it runs in a loop (default every 60s) and writes PMCI snapshots, keeping data live. The repo does not include a scheduler (cron, GitHub Actions, or process manager) to start it; something must run the observer process 24/7 (e.g. on a server or in a long-lived terminal) for freshness to stay `ok`.

---

## A) Live freshness

- **API running:** Yes (`npm run api:pmci`).
- **Observer running:** Not started for this run (validation used existing DB state).
- **GET /v1/health/freshness:** Responded 200.
  - **status:** `stale` (not `ok` — see below).
  - **lag_seconds:** ~171814 (latest snapshot ~2 days old).
- **Watcher:** Ran `pmci:watch` for 3+ intervals (5s interval, maxStaleChecks=10); did not exit non-zero (stopped by kill after 18s).

**Freshness result:** Status = **stale**. Reason: no recent ingestion; `latest_snapshot_at` is 2026-02-26T05:19:00Z; lag exceeds 120s. To get `ok`, run observer and ensure snapshots are written within the lag threshold.

---

## B) Data presence sanity

- **npm run pmci:probe:** Exit 0.
- **Counts:**
  - provider_markets: 122
  - snapshots: 1098
  - families: 61
  - current_links: 122
- **latest_snapshot_at:** 2026-02-26T05:19:00Z (recent enough for data checks; not recent for freshness SLO).

---

## C) Per-event API validation

### DEM (c8515a58-c984-46fe-ac65-25e362e68333)

- **GET /v1/market-families?event_id=DEM:** Array length **35** (> 0). Each sampled item has `num_links == 2`.
- **Sample family_id:** 1.
  - **GET /v1/market-links?family_id=1:** 2 legs (kalshi + polymarket); prices and consensus present.
  - **GET /v1/signals/divergence?family_id=1:** 2 rows; sorted by divergence desc.
- **GET /v1/signals/top-divergences?event_id=DEM&limit=10:** ≤10 items; sorted by max_divergence desc; when both legs have price_yes, max_divergence non-null. last_observed_at = 2026-02-26T05:18:46.488Z.

**Top 3 divergences (DEM):**

| family_id | label | max_divergence | consensus_price |
|-----------|--------|----------------|------------------|
| 6 | democratic-presidential-nominee-2028::J.B. Pritzker | ~0.0295 | ~0.05 |
| 4 | democratic-presidential-nominee-2028::Josh Shapiro | ~0.029 | ~0.07 |
| 3 | democratic-presidential-nominee-2028::Jon Ossoff | ~0.028 | ~0.07 |

### GOP (1679cc97-88b0-4ad4-a29c-b483ed94f6df)

- **GET /v1/market-families?event_id=GOP:** Array length **26** (> 0). Each sampled item has `num_links == 2`.
- **Sample family_id:** 36 (first returned).
  - **GET /v1/market-links?family_id=36:** 2 legs.
  - **GET /v1/signals/divergence?family_id=36:** 2 rows (when prices present).
- **GET /v1/signals/top-divergences?event_id=GOP&limit=10:** ≤10 items; sorted by max_divergence desc; max_divergence non-null when both legs have price_yes. last_observed_at = 2026-02-26T05:19:00.533Z.

**Top 3 divergences (GOP):**

| family_id | label | max_divergence | consensus_price |
|-----------|--------|----------------|------------------|
| 38 | republican-presidential-nominee-2028::Robert F. Kennedy Jr. | ~0.47 | ~0.02 |
| 50 | republican-presidential-nominee-2028::Marco Rubio | ~0.059 | ~0.20 |
| 52 | republican-presidential-nominee-2028::Ron DeSantis | ~0.038 | ~0.06 |

---

## D) Coverage/discovery (optional)

- **GET /v1/coverage/summary?provider=kalshi:** total_markets=61, linked/unlinked present.
- **GET /v1/coverage/summary?provider=polymarket:** total_markets=61.
- **GET /v1/markets/new?provider=kalshi&since=24h&limit=5:** 200; 0 new in 24h.
- **GET /v1/markets/new?provider=polymarket&since=24h&limit=5:** 200; 0 new in 24h.

---

## Pass/Fail conclusion

| Check | Result |
|-------|--------|
| API up | **PASS** |
| Freshness status = ok | **FAIL** (status = stale; lag ~2 days) |
| Probe counts (markets, snapshots, families, links) | **PASS** |
| Watcher 3 intervals, no self-exit non-zero | **PASS** |
| DEM families, links, divergence, top-divergences | **PASS** |
| GOP families, links, divergence, top-divergences | **PASS** |
| Coverage summary + markets/new | **PASS** |

**Overall:** **FAIL** — due to freshness not `ok`. All signal and data-path checks for DEM and GOP pass.

**If any failure – exact diagnosis + next fix (one line):**  
Freshness is `stale` because the latest snapshot is ~2 days old — no observer process was running to keep data live. **Fix:** Run the observer continuously (e.g. `npm run start` in a process manager or on a server) so PMCI ingestion writes new snapshots; re-check `/v1/health/freshness` until `status=ok` and `lag_seconds` ≤ 120.

---

## Artifacts

- Validation script: `scripts/pmci-validate-politics.mjs`
- NPM script: `npm run pmci:validate:politics` (exit 0 = all pass; non-zero = at least one failure; currently fails on freshness when data is stale).
