import { z } from "zod";

const boolFromEnv = z
  .enum(["0", "1", "true", "false"])
  .transform((v) => v === "1" || v === "true");

export const configSchema = z.object({
  DATABASE_URL: z.string().min(1, "Missing DATABASE_URL env var"),
  PORT: z.coerce.number().int().positive().default(8787),
  PMCI_MAX_LAG_SECONDS: z.coerce.number().int().positive().default(120),
  PMCI_INGESTION_SUCCESS_TARGET: z.coerce.number().min(0).max(1).default(0.99),
  PMCI_API_P95_TARGET_MS: z.coerce.number().int().positive().default(500),
  PMCI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  PMCI_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  PMCI_ADMIN_KEY: z.string().optional(),
  PMCI_API_KEY: z.string().optional(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_SSL: boolFromEnv.optional(),
});

export function getConfigFromEnv(env = process.env) {
  return configSchema.parse(env);
}

export function getPmciApiConfig(env = process.env) {
  const cfg = getConfigFromEnv(env);
  return {
    port: cfg.PORT,
    maxLagSeconds: cfg.PMCI_MAX_LAG_SECONDS,
    ingestionSuccessTarget: cfg.PMCI_INGESTION_SUCCESS_TARGET,
    apiP95TargetMs: cfg.PMCI_API_P95_TARGET_MS,
    rateLimitMax: cfg.PMCI_RATE_LIMIT_MAX,
    rateLimitWindowMs: cfg.PMCI_RATE_LIMIT_WINDOW_MS,
    adminKey: cfg.PMCI_ADMIN_KEY,
    apiKey: cfg.PMCI_API_KEY,
    dbUrl: cfg.DATABASE_URL,
    pgPoolMax: cfg.PG_POOL_MAX,
    pgSsl: cfg.PG_SSL,
  };
}
