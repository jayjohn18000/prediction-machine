#!/usr/bin/env node
/**
 * PMCI Phase 2: Propose equivalent and proxy links for politics (Kalshi ↔ Polymarket).
 * Thin CLI wrapper around lib/matching/proposal-engine.mjs.
 * Env: DATABASE_URL, PMCI_MAX_PROPOSALS_EQUIV, PMCI_MAX_PROPOSALS_PROXY, PMCI_MAX_PER_BLOCK.
 */

import { loadEnv } from "../src/platform/env.mjs";
import { runProposalEngine } from "../lib/matching/proposal-engine.mjs";

loadEnv();

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const marketIdx = argv.indexOf("--market");
const marketFilter = marketIdx >= 0 ? argv[marketIdx + 1] : null;
const explain = argv.includes("--explain");

runProposalEngine({ dryRun, marketFilter, explain })
  .then((result) => {
    console.log(result.summary);
    process.exit(result.ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("pmci:propose:politics FAIL:", err.message);
    process.exit(1);
  });
