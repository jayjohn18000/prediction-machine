/**
 * PMCI API entrypoint. Builds the Fastify app via server.mjs and listens.
 */
import { loadEnv } from "./platform/env.mjs";
import { getPmciApiConfig } from "./platform/config-schema.mjs";
import { buildApp } from "./server.mjs";

loadEnv();
const config = getPmciApiConfig(process.env);

const app = await buildApp();
await app.listen({ port: config.port, host: "0.0.0.0" });
