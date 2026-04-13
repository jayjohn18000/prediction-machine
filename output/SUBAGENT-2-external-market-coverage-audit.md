# Subagent 2 — External market coverage audit

**Question:** Why do third-party arb / market APIs surface Kalshi↔Polymarket opportunities your ingestor does not?

**Method:** Cross-check public API semantics ([Kalshi Get Markets](https://docs.kalshi.com/api-reference/market/get-markets), [Polymarket List events](https://docs.polymarket.com/api-reference/events/list-events)) with patterns in this repo (`lib/ingestion/universe.mjs`, `lib/ingestion/sports-universe.mjs`, `lib/providers/*.mjs`). `parallel-cli` was not available in this environment; citations use fetched official docs plus repo evidence.

**Assumption:** “Arb API” means a service that aggregates **both** venues with broader discovery (search, websockets, internal indexing, or paid feeds), not necessarily identical REST parameters to your scripts.

---

## Likely causes (concise)

1. **Discovery scope** — Your politics path uses curated series/slug strategies; sports uses Kalshi `category=Sports` series list + Polymarket tag/slug heuristics (`lib/ingestion/sports-universe.mjs`). Any market outside those series/tags (niche sports, props, cross-listed specials) never enters `provider_markets`.

2. **Lifecycle / filter mismatch** — Kalshi’s **query** `status` filter allows `unopened`, `open`, `closed`, `settled` (empty = any) per [Get Markets](https://docs.kalshi.com/api-reference/market/get-markets). Polymarket Gamma `/events` exposes `active`, `archived`, `closed`, tags, offsets, etc. per [List events](https://docs.polymarket.com/api-reference/events/list-events). If your code fixes `active=true` on events but uses different semantics on nested markets (your sports file documents prior `active=true` issues on **markets** lists), you can miss tradable nested markets still shown elsewhere.

3. **Pagination / cursors** — Kalshi documents cursor + `limit` pagination ([pagination guide](https://docs.kalshi.com/getting_started/pagination)). Under-paginating or hard page caps (see repo: sports event page cap, `limit=200` markets per event) drops the tail of catalogs that an aggregator paginates fully.

4. **Normalization** — Cross-venue matching requires aligned entities (teams, dates, props). Arb tools may use proprietary fuzzy matching; your pipeline still has brittle string joins (e.g. `lib/providers/polymarket.mjs` outcome matching). Ingestion can succeed but **links** never form.

5. **Rate limits & backoff** — Partial catalogs under 429 without `Retry-After` handling (sports Kalshi helper) yield incomplete universes; APIs that cache centrally see more.

6. **Internal vs API “proposed/accepted”** — Third-party “proposed” opportunities may be **derived** (model output), not the venues’ publication state. Your DB tracks PMCI proposal workflow separately; vocabulary is not 1:1 with Kalshi/Polymarket product terms.

---

## Checklist: API / query mismatches to verify in code

- [ ] Kalshi: Are you passing `status` when you mean “all tradable”? (Empty status returns any; single status filter only one value [Get Markets](https://docs.kalshi.com/api-reference/market/get-markets).)
- [ ] Kalshi: Do you follow `cursor` until null for every series/event sweep?
- [ ] Kalshi: Do you need `/historical/markets` for older settled rows per doc note on [Get Markets](https://docs.kalshi.com/api-reference/market/get-markets)?
- [ ] Polymarket: For each `/events` query, are `active`, `closed`, `archived` consistent with how you classify “live” in DB?
- [ ] Polymarket: Do nested markets inside events inherit different flags than the parent event?
- [ ] Polymarket: Are `tag_id` / `tag_slug` / `exclude_tag_id` filters excluding edges you care about?
- [ ] Offset vs cursor: Gamma list endpoints use `limit`/`offset` per [List events](https://docs.polymarket.com/api-reference/events/list-events) — confirm you are not stopping early (compare to repo caps).
- [ ] After ingest: Does PMCI sweep query match stored `status` values? (Repo: `open` only in sweep vs `active` writers — see Subagent 1.)

---

## Endpoint / filter combinations worth testing

**Kalshi (trade API v2)**

- `GET /markets` with **no** `status` (full lifecycle sample), then with `status=open` only.
- `GET /markets` with `series_ticker=<T>` + cursor walk until end.
- `GET /markets` with `event_ticker=<T>` + cursor walk.
- Compare response count to `status=closed` for the same ticker window (understanding settlement lag).

**Polymarket Gamma**

- `GET /events?active=true&closed=false&archived=false&limit=...` with full offset pagination.
- Same with additional `tag_id=<sportsTag>` vs without (measure false negatives).
- `GET /markets` (if used) with documented filters per [Fetching Markets](https://docs.polymarket.com/developers/gamma-markets-api/get-markets) — validate `active` vs `closed` vs `archived` behavior on **market** resource (your code comments indicate past mismatch).

**Cross-check**

- Pick 10 tickers/slugs an arb API shows; grep your DB (`provider_market_ref`) and logs for presence — classify misses as discovery vs matching vs snapshot staleness.

---

## Most likely failure modes (ranked)

| Rank | Failure mode | Probability driver |
|------|----------------|-------------------|
| 1 | **Incomplete pagination / caps** in custom ingestors | High — explicit page limits in `sports-universe.mjs`; human arb tools typically crawl until exhaustion. |
| 2 | **Discovery filter too narrow** (series/tags vs global search) | High — Polymarket [Search](https://docs.polymarket.com/api-reference/search/search-markets-events-and-profiles) and aggregators cast a wider net than tag walks. |
| 3 | **Status mismatch** between ingest writers and sweep / observers | High-Med — confirmed `open` vs `active` in repo for sweep SQL. |
| 4 | **Matching not run or category-limited** (`proposal-engine` politics-only) | Med — rows exist but no linked family. |
| 5 | **429 / transient errors** without robust retry on one leg | Med — asymmetric retry between politics and sports in repo. |
| 6 | **Semantic drift** (props wording, abbreviations) | Med — fuzzy matchers beat strict token rules. |
| 7 | **Lag** — arb API near-real-time vs your interval / batch | Low-Med — operational, not structural. |

---

## Sources

- [Kalshi — Get Markets](https://docs.kalshi.com/api-reference/market/get-markets) — market `status` filter values; timestamp compatibility; historical markets note.
- [Kalshi — Understanding pagination](https://docs.kalshi.com/getting_started/pagination) — cursor workflow.
- [Polymarket — List events](https://docs.polymarket.com/api-reference/events/list-events) — `active`, `archived`, `closed`, `tag_id`, pagination parameters.
- [Polymarket — Search markets, events, and profiles](https://docs.polymarket.com/api-reference/search/search-markets-events-and-profiles) — broader discovery than tag-only walks.
- [Polymarket — Get markets (Gamma)](https://docs.polymarket.com/developers/gamma-markets-api/get-markets) — market-level listing behavior.

---

*Generated 2026-04-13.*
