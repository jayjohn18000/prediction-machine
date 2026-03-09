/**
 * PMCI API entrypoint. Builds the Fastify app via server.mjs and listens.
 */
import { loadEnv } from "./platform/env.mjs";
import { buildApp } from "./server.mjs";

loadEnv();

const PORT = Number(process.env.PORT ?? 8787);

const app = await buildApp();
await app.listen({ port: PORT, host: "0.0.0.0" });
