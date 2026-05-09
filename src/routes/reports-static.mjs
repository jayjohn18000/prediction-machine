/**
 * Serves HTML under `reports/daily/*.html` and `reports/weekly/*.html` from PMCI_REPORTS_LOCAL_DIR or `./reports/`.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getReportsRoot } from "../../lib/scanner/report-paths.mjs";

/**
 * @param {import('fastify').FastifyInstance} app
 */
export function registerReportStaticRoutes(app) {
  const root = getReportsRoot();

  app.get("/reports/daily/:file", async (req, reply) => {
    const base = path.basename(String(req.params.file ?? ""));
    if (!base.endsWith(".html")) return reply.code(404).send({ error: "invalid" });
    const dailyRoot = path.join(root, "daily");
    const fp = path.normalize(path.join(dailyRoot, base));
    if (!fp.startsWith(dailyRoot)) return reply.code(400).send({ error: "path" });
    try {
      const buf = await fs.readFile(fp, "utf8");
      reply.header("Cache-Control", "public, max-age=300");
      return reply.type("text/html; charset=utf-8").send(buf);
    } catch {
      return reply.code(404).send({ error: "missing", hint: `/reports/daily/${base}` });
    }
  });

  app.get("/reports/weekly/:file", async (req, reply) => {
    const base = path.basename(String(req.params.file ?? ""));
    if (!base.endsWith(".html")) return reply.code(404).send({ error: "invalid" });
    const weeklyRoot = path.join(root, "weekly");
    const fp = path.normalize(path.join(weeklyRoot, base));
    if (!fp.startsWith(weeklyRoot)) return reply.code(400).send({ error: "path" });
    try {
      const buf = await fs.readFile(fp, "utf8");
      reply.header("Cache-Control", "public, max-age=300");
      return reply.type("text/html; charset=utf-8").send(buf);
    } catch {
      return reply.code(404).send({ error: "missing", hint: `/reports/weekly/${base}` });
    }
  });
}
