/**
 * POST /v1/admin/jobs/:jobName — triggered by Supabase Edge Function dispatcher.
 * Most jobs spawn a detached child; MM operational jobs (`mm-pnl-snapshot`, `mm-post-fill-backfill`)
 * run in-process so failures surface as non-2xx (cron/pg_cron observability).
 * Auth: global x-pmci-api-key hook (server.mjs) + admin key gate.
 */
import { spawn } from "child_process";
import { createPgClient } from "../../lib/mm/order-store.mjs";
import { insertPnlSnapshotsAllEnabledMarkets } from "../../lib/mm/pnl-attribution.mjs";
import { backfillPostFillMids } from "../../lib/mm/post-fill-backfill.mjs";
import { runRotation } from "../../scripts/mm/rotate-demo-tickers.mjs";
import { runHeartbeat } from "../../scripts/mm/mm-stream-heartbeat.mjs";

const ADMIN_JOBS = {
  "ingest-sports":    ["node", ["lib/ingestion/sports-universe.mjs"]],
  "ingest-politics":  ["node", ["scripts/ingestion/pmci-ingest-politics-universe.mjs"]],
  "ingest-economics": ["node", ["lib/ingestion/economics-universe.mjs"]],
  "ingest-crypto":    ["node", ["lib/ingestion/crypto-universe.mjs"]],
  "stale-cleanup":    ["node", ["scripts/stale-cleanup.mjs"]],
  "verify-schema":    ["node", ["scripts/validation/verify-pmci-schema.mjs"]],
  "audit-live":       ["bash", ["scripts/run_pmci_live_audit.sh"]],
  "review-crypto":    ["node", ["scripts/review/pmci-review-category-pipeline.mjs"]],
  "review-economics": ["node", ["scripts/review/pmci-review-category-pipeline.mjs", "--economics"]],
  "status-digest":    ["node", ["scripts/digest/pmci-daily-digest.mjs"]],
  "benchmark-coverage": ["node", ["scripts/benchmark/coverage-benchmark.mjs"]],
  "health-poll":      ["node", ["scripts/ops/pmci-health-poll.mjs"]],
};

export function registerAdminJobRoutes(app, deps) {
  const { PMCI_ADMIN_KEY, RATE_LIMIT_CONFIG } = deps;

  function adminKeyGate(req, reply, done) {
    if (PMCI_ADMIN_KEY && req.headers["x-pmci-admin-key"] !== PMCI_ADMIN_KEY) {
      reply.code(403).send({ error: "forbidden", message: "admin key required" });
      return;
    }
    done();
  }

  app.post(
    "/v1/admin/jobs/:jobName",
    { preHandler: [adminKeyGate], rateLimit: RATE_LIMIT_CONFIG },
    async (req, reply) => {
      const { jobName } = req.params;

      if (jobName === "mm-pnl-snapshot") {
        const client = createPgClient();
        await client.connect();
        try {
          const out = await insertPnlSnapshotsAllEnabledMarkets(client);
          const failures = out.results.filter((x) => !x.ok);
          if (failures.length > 0) {
            return reply.code(500).send({
              ok: false,
              job: jobName,
              error: "one_or_more_snapshots_failed",
              inserted: out.inserted,
              failures,
              results: out.results,
            });
          }
          return reply.code(200).send({ ok: true, job: jobName, inserted: out.inserted, results: out.results });
        } catch (err) {
          return reply.code(500).send({
            ok: false,
            job: jobName,
            error: /** @type {Error} */ (err).message,
          });
        } finally {
          await client.end().catch(() => {});
        }
      }

      if (jobName === "mm-post-fill-backfill") {
        const client = createPgClient();
        await client.connect();
        try {
          const stats = await backfillPostFillMids({ client, now: new Date() });
          return reply.code(200).send({ ok: true, job: jobName, ...stats });
        } catch (err) {
          return reply.code(500).send({
            ok: false,
            job: jobName,
            error: /** @type {Error} */ (err).message,
          });
        } finally {
          await client.end().catch(() => {});
        }
      }

      if (jobName === "mm-rotate-tickers") {
        const client = createPgClient();
        await client.connect();
        try {
          const summary = await runRotation({ client });
          return reply.code(summary.ok ? 200 : 500).send({ job: jobName, ...summary });
        } catch (err) {
          return reply.code(500).send({
            ok: false,
            job: jobName,
            error: /** @type {Error} */ (err).message,
          });
        } finally {
          await client.end().catch(() => {});
        }
      }

      if (jobName === "mm-stream-heartbeat") {
        const client = createPgClient();
        await client.connect();
        try {
          const summary = await runHeartbeat({ client });
          return reply.code(summary.ok ? 200 : 503).send({ job: jobName, ...summary });
        } catch (err) {
          return reply.code(500).send({
            ok: false,
            job: jobName,
            error: /** @type {Error} */ (err).message,
          });
        } finally {
          await client.end().catch(() => {});
        }
      }

      const job = ADMIN_JOBS[jobName];
      if (!job) {
        return reply.code(404).send({
          error: "unknown job",
          jobName,
          available: [
            ...Object.keys(ADMIN_JOBS),
            "mm-pnl-snapshot",
            "mm-post-fill-backfill",
            "mm-rotate-tickers",
            "mm-stream-heartbeat",
          ],
        });
      }

      const [cmd, args] = job;
      const child = spawn(cmd, args, {
        detached: true,
        // Inherit stdout/stderr so job logs reach Fly logs; piped + unread drops them.
        stdio: ["ignore", "inherit", "inherit"],
        cwd: process.cwd(),
        env: { ...process.env },
      });
      child.unref();

      const pid = child.pid;
      console.log(`[admin-jobs] spawned job=${jobName} pid=${pid}`);
      return reply.code(202).send({ job: jobName, pid, status: "spawned" });
    }
  );

  app.get(
    "/v1/admin/jobs",
    { preHandler: [adminKeyGate], rateLimit: RATE_LIMIT_CONFIG },
    async () => ({
      available: [
        ...Object.keys(ADMIN_JOBS),
        "mm-pnl-snapshot",
        "mm-post-fill-backfill",
        "mm-rotate-tickers",
        "mm-stream-heartbeat",
      ].sort(),
    })
  );
}
