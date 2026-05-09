---
title: PMCI Scanner Output Design
tags: [scanner, output, daily-report, pager, dashboard, cli, v1]
status: current
last-verified: 2026-05-08
sources:
  - "[[scanner-plan-v1]]"
  - "[[hypothesis-tracker-template]]"
  - "[[backtest-engine-design]]"
---

# Scanner Output Design

**Created:** 2026-05-08
**Status:** PLAN — build to follow
**Audience:** anyone building the operator-facing surface of the scanner

---

## §1 Purpose

The scanner produces three operator-facing outputs:

1. **Daily report** — hybrid format (paragraphs for `live`, one-liners for `scanning`), rendered overnight as static HTML to S3
2. **Pager alerts** — webhook-driven push / Slack / email, FK-trigger-gated to live hypotheses only
3. **Weekly digest** — Sunday cron with cross-day patterns, decay table, promotion candidates

Plus operator CLI tools for state transitions and on-demand report generation. This doc specifies each, including SQL ranking, HTML template skeleton, webhook payload, and the `pmci-hypothesis` / `pmci-report` commands.

---

## §2 Daily report

### 2.1 Generation

Cron job at 00:30 UTC. Reads from:
- `pmci.scanner_signals_unified` view (filtered to last 24h)
- `pmci.hypotheses` (status, mechanism_md)
- `pmci.source_chains` (hit_rate_30d + bootstrap CI)
- `pmci.hypothesis_decay_state` (PSI / KSWIN status)

Writes to: `s3://pmci-reports/daily/YYYY-MM-DD.html`. Bucket policy: signed URL only; operator gets the signed URL emailed each morning by the same cron.

### 2.2 Ranking SQL

```sql
SELECT
  s.signal_id,
  s.market_ticker,
  s.signal_strength_cents,
  s.hypothesis_id,
  h.name,
  h.status,
  h.mechanism_md,
  sc.hit_rate_30d,
  sc.hit_rate_ci_low,
  sc.hit_rate_ci_high,
  s.signal_strength_cents * COALESCE(sc.hit_rate_30d, 0.5) AS rank_score,
  CASE WHEN sc.hit_rate_ci_low <= 0.50 THEN '*' ELSE '' END AS unreliable_marker
FROM pmci.scanner_signals_unified s
JOIN pmci.hypotheses h ON h.id = s.hypothesis_id
LEFT JOIN pmci.source_chains sc ON sc.id = s.source_chain_id
WHERE s.observed_at >= now() - interval '24 hours'
ORDER BY rank_score DESC;
```

Asterisks flag rows where the source chain's hit-rate CI lower bound includes 0.50 — point estimate is unreliable; treat with caution.

### 2.3 HTML template skeleton

Handlebars, single static page, monospace flat CSS. No client JS — portability over interactivity.

```html
<!DOCTYPE html>
<html><head><title>PMCI Daily Report — {{date}}</title>
<style>
  body { font-family: monospace; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  article { border-left: 3px solid #ccc; padding-left: 1rem; margin: 1.5rem 0; }
  table { border-collapse: collapse; margin-top: 0.5rem; }
  td, th { padding: 0.25rem 0.75rem; border: 1px solid #ddd; }
  .alarm { color: #c00; }
  ul.scanning li { font-size: 0.9rem; }
</style></head>
<body>
<h1>PMCI Daily Report — {{date}}</h1>
<section id="summary">
  <p>Signals 24h: {{total}} | Live hypotheses: {{liveCount}} | Decay alarms: <span class="alarm">{{decayAlarms}}</span></p>
</section>

<section id="live-hypotheses">
  <h2>Live hypotheses</h2>
  {{#each liveHypotheses}}
  <article>
    <h3>{{id}} — {{name}}</h3>
    <p class="pillar">{{mechanism_first_paragraph}}</p>
    <p class="source">Source: {{source_chain.world_event}} → {{source_chain.public_source}} → {{source_chain.detection}}</p>
    <p class="action"><strong>Recommended:</strong> {{recommended_action}}</p>
    <table>
      <tr><th>24h signals</th><th>30d hit rate</th><th>CI</th><th>Realized PnL</th></tr>
      <tr><td>{{n_today}}</td><td>{{hit_rate_30d}}</td><td>[{{ci_low}}, {{ci_high}}]</td><td>{{realized_pnl}}c</td></tr>
    </table>
  </article>
  {{/each}}
</section>

<section id="scanning-hypotheses">
  <h2>Scanning hypotheses</h2>
  <ul class="scanning">
    {{#each scanningSignals}}
    <li>[{{type}}] {{market_ticker}} | edge: {{signal_strength_cents}}c | source: {{source_chain_short}} | hyp: {{hypothesis_id}} | resolved: {{n_resolved}}/{{required}} {{unreliable_marker}}</li>
    {{/each}}
  </ul>
</section>

<section id="decay-alarms">
  <h2 class="alarm">Decay alarms</h2>
  {{#each decayAlarms}}
  <p>{{hypothesis_id}}: weighted_drift={{weighted_drift}}, KSWIN={{streaming_kswin_alarm}} → AUTO-RETIRED</p>
  {{/each}}
</section>
</body></html>
```

Renderer: Handlebars or EJS in Node.js. Static HTML for portability and speed; <100KB per report.

### 2.4 Hosting

S3 static website hosting. Bucket policy: signed URL only. Cost: <$1/month at v1 scale.

Alternative if S3 setup is friction: render to local folder + serve via Fly's existing nginx reverse proxy at `/reports/daily/`. Operator already has Fly auth.

---

## §3 Pager alerts

### 3.1 Trigger logic

Compositor evaluates per-tick. When a `market_signals` row has `net_edge_c > threshold` (default 2c, configurable per-hypothesis) AND there's a `live` hypothesis matching `dominant_hypothesis_id`, attempt to insert into `pmci.alerts`.

```sql
INSERT INTO pmci.alerts (
  hypothesis_id, signal_id, signal_type, message,
  webhook_target, tradable, current_allocation_c
) VALUES (...);
```

The `BEFORE INSERT` trigger raises an exception if hypothesis is not in `live` status — caller (compositor) catches and skips. This is the FK-gate from `scanner-plan-v1.md` §8.

### 3.2 Webhook payload

```json
{
  "alert_id": "uuid",
  "hypothesis_id": "H-2026-001",
  "fired_at": "2026-05-09T22:14:33Z",
  "signal_type": "informational_lag",
  "message": "MINWSH lag: WPA -0.07, Kalshi mid stable 47s, divergence 4.2c",
  "tradable": true,
  "current_allocation_c": 5000,
  "context": {
    "market_ticker": "KXNBASEA-26MAY09SF-LAL",
    "signal_strength_cents": 4.2,
    "source_chain_id": "uuid",
    "hit_rate_30d": 0.62,
    "hit_rate_ci_low": 0.54
  }
}
```

`tradable: false` if portfolio allocator has the strategy at $0 budget this week. Bot ignores; operator dashboard dims. Alert still fires with metadata so the operator can see the strategy was firing during a no-budget period.

### 3.3 Delivery

Three webhook targets in v1:

| Target | Format |
|---|---|
| **Slack** | `webhook_url` per hypothesis. Posts to a configured channel. |
| **Email** | `email_address` per hypothesis. Plain text, no inline HTML. |
| **HTTP POST** | Generic webhook. Used by `pmci-mm-runtime` to subscribe. |

Delivery worker: cron every 60s reads `pmci.alerts WHERE delivered_at IS NULL`, attempts delivery, updates `delivered_at` + `delivery_status`. Retry up to 3 times with exponential backoff (1s, 5s, 25s).

### 3.4 Rate limiting

Per-hypothesis cap: 10 alerts/hour. Beyond that, alerts batch into a digest (one alert summarizing many). Prevents alert storms on a runaway detector.

---

## §4 Weekly digest

Sunday 06:00 UTC cron. Same generation pattern as daily report; written to `s3://pmci-reports/weekly/YYYY-WW.html`.

### 4.1 Cross-day patterns

Identifies signals that fired across multiple days for the same `(market_ticker, source_chain_id)` pair. These are the wallet-archaeology candidates — repeating patterns suggest a single operator with a reproducible strategy.

```sql
SELECT market_ticker, source_chain_id, COUNT(DISTINCT date(observed_at)) AS active_days,
       AVG(signal_strength_cents) AS avg_edge
FROM pmci.scanner_signals_unified
WHERE observed_at >= now() - interval '7 days'
GROUP BY market_ticker, source_chain_id
HAVING COUNT(DISTINCT date(observed_at)) >= 3
ORDER BY active_days DESC, avg_edge DESC;
```

### 4.2 Decay table

Hypotheses tripped PSI > 0.2 OR KSWIN this week. Already auto-retired by nightly cron. Operator reviews to confirm or manual-override (rare; e.g., if the trip was caused by a Kalshi outage, not a real signal change).

### 4.3 Promotion candidates

Hypotheses that cleared posture thresholds for `scanning → testing` or `testing → live` this week (per `hypothesis-tracker-template.md` §4 STANDARD posture). Operator inspects and decides on `promoted_at`.

### 4.4 Capital allocation summary

Portfolio allocator's weekly output. Per-hypothesis: previous allocation, new allocation, reason (`pro_rata` / `min_threshold` / `capacity_capped`).

### 4.5 Retirement list

Hypotheses retired this week with reason (`decay`, `falsified`, `manual`, `drawdown`).

---

## §5 Operator CLI tools

For v1, review is via CLI tools, not a web dashboard. CLI is enough; web dashboard is post-build polish.

### 5.1 `pmci-hypothesis` command

Lives in `scripts/cli/pmci-hypothesis.mjs`. Thin Node.js wrapper around DB queries + the backtest engine.

```bash
pmci-hypothesis list --status scanning
pmci-hypothesis show H-2026-001
pmci-hypothesis promote H-2026-001 --to testing
pmci-hypothesis retire H-2026-001 --reason manual
pmci-hypothesis backtest H-2026-001 --days 30        # invokes scripts/backtest/run-backtest.mjs
pmci-hypothesis decay H-2026-001                     # show current PSI/KSWIN state
pmci-hypothesis stages H-2026-001                    # the 3-stage comparison query
```

Promote/retire commands write an audit-log row capturing `(hypothesis_id, from_status, to_status, transition_at, reason, actor)`. See `hypothesis-tracker-template.md` Appendix A.

### 5.2 `pmci-report` command

```bash
pmci-report daily --date 2026-05-08            # render daily report on demand
pmci-report weekly --week 2026-W19             # render weekly digest on demand
pmci-report dashboard                          # local HTML server on port 8080, hot-reloads on data change
```

The `dashboard` subcommand spins up a tiny Express server (or even just `python3 -m http.server`) for development. Re-renders the latest report on every request.

---

## §6 Build sequencing

| Week | Deliverable |
|---|---|
| 1 | Daily report generator + Handlebars template + S3 upload (or Fly nginx fallback) |
| 2 | Pager alert delivery worker (Slack + email + HTTP POST) |
| 2 | `pmci-hypothesis` CLI — list, show, promote, retire commands |
| 3 | Weekly digest generator |
| 3 | `pmci-report` CLI — daily, weekly, dashboard subcommands |
| 4 | Rate limiting + alert batching |

**Total ~3 weeks. Independent of MM redesign and detector work** — parallel build stream.

---

## §7 Reference

- `Polymarket/poly-market-maker` — graceful SIGTERM cancel pattern (used in delivery-worker shutdown)
- `callmevojtko/Recommended-Bets-By-Email-MLB` `email_utils.py` — Gmail API + base64 MIME (port to Node)
- `freqtrade/freqtrade` — Notification plugin pattern for multi-target webhook delivery

## §8 Cross-references

- `~/prediction-machine/docs/scanner/scanner-plan-v1.md` §9 — output specifications (this doc expands them)
- `~/prediction-machine/docs/strategies/hypothesis-tracker-template.md` §7 — weekly review ritual (consumes the digest)
- `~/prediction-machine/docs/scanner/backtest-engine-design.md` — `pmci-hypothesis backtest` invocation target
- `~/prediction-machine/docs/strategies/mm-runtime-redesign-v2.md` §6.2 — `pmci-mm-runtime` is one of the HTTP POST webhook subscribers
