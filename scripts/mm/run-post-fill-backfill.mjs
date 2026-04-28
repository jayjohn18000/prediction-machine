#!/usr/bin/env node
/**
 * Spawned by Fly PMCI API admin job `mm-post-fill-backfill` (Supabase pg_cron → job-runner).
 */
import { runPostFillBackfillCron } from "../../lib/mm/post-fill-cron-handler.mjs";

const stats = await runPostFillBackfillCron();
console.log("[mm-post-fill-backfill]", JSON.stringify(stats));
