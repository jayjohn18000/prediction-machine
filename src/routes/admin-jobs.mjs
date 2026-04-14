/**
 * POST /v1/admin/jobs/:jobName — triggered by Supabase Edge Function dispatcher.
 * Spawns the requested job as a detached child process; output goes to PM2 logs.
 * Auth: global x-pmci-api-key hook (server.mjs) + admin key gate.
 */
import { spawn } from "child_process";

const ADMIN_JOBS = {
  "ingest-sports":    ["node", ["lib/ingestion/sports-universe.mjs"]],
  "ingest-politics":  ["node", ["scripts/ingestion/pmci-ingest-politics-universe.mjs"]],
  "ingest-economics": ["node", ["lib/ingestion/economics-universe.mjs"]],
  "ingest-crypto":    ["node", ["lib/ingestion/crypto-universe.mjs"]],
  "stale-cleanup":    ["node", ["scripts/stale-cleanup.mjs"]],
  "verify-schema":    ["node", ["scripts/validation/verify-pmci-schema.mjs"]],
  "audit-live":       ["bash", ["scripts/run_pmci_live_audit.sh"]],
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
      const job = ADMIN_JOBS[jobName];
      if (!job) {
        return reply.code(404).send({
          error: "unknown job",
          jobName,
          available: Object.keys(ADMIN_JOBS),
        });
      }

      const [cmd, args] = job;
      const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
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
      available: Object.keys(ADMIN_JOBS),
    })
  );
}
