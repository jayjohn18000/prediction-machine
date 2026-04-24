/**
 * One observer cycle: fetch prices from providers, write Supabase rows,
 * and append PMCI snapshots + heartbeat.
 */
import { fetchKalshiPriceMap } from "../providers/kalshi.mjs";
import { fetchPolymarketPriceMap } from "../providers/polymarket.mjs";
import {
  createPmciClient,
  getProviderIds,
  ingestPair,
  addIngestionCounts,
  writeHeartbeat,
  touchProvidersLastSnapshotAt,
  flushSnapshotBuffer,
} from "../pmci-ingestion.mjs";
import { runPmciSweep } from "./pmci-sweep.mjs";
import { runAutoLinkPass } from "../matching/auto-linker.mjs";

const PMCI_DEBUG = process.env.PMCI_DEBUG === "1";
const OBSERVER_AUTO_LINK_PASS = process.env.OBSERVER_AUTO_LINK_PASS === "1" || process.env.OBSERVER_AUTO_LINK_PASS === "true";

function isPriceValid(value) {
  if (value == null || Number.isNaN(value)) return false;
  const n = Number(value);
  return n >= 0 && n <= 1;
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

function groupPairsByEvent(pairs) {
  const groups = new Map();
  for (const p of pairs) {
    const eventTicker = p.kalshiTicker.replace(/-[^-]+$/, "");
    const slug = p.polymarketSlug;
    const key = `${eventTicker}\t${slug}`;
    if (!groups.has(key)) groups.set(key, { eventTicker, slug, pairs: [] });
    groups.get(key).pairs.push(p);
  }
  return [...groups.values()];
}

async function runOneCycleForEvent(
  eventTicker,
  slug,
  pairs,
  supabase,
  pmciClientRef,
  pmciReport,
  pmciIdsRef,
  cycleErrors,
  snapshotBuffer,
) {
  if (pairs.length === 0) return;

  cycleErrors.pairsConfigured += pairs.length;

  const kalshiResult = await fetchKalshiPriceMap(eventTicker);
  cycleErrors.jsonParseErrors += kalshiResult.jsonParseErrors ?? 0;
  if (!kalshiResult.ok || !kalshiResult.map) {
    cycleErrors.kalshiFetchErrors += 1;
    return;
  }
  const kalshiMap = kalshiResult.map;

  const polyResult = await fetchPolymarketPriceMap(slug, pairs);
  cycleErrors.jsonParseErrors += polyResult.jsonParseErrors ?? 0;
  if (!polyResult.ok || !polyResult.map) {
    cycleErrors.polymarketFetchErrors += 1;
    return;
  }
  const polymarketMap = polyResult.map;

  const observedAt = new Date().toISOString();

  for (const pair of pairs) {
    cycleErrors.pairsAttempted += 1;
    const k = kalshiMap.get(pair.kalshiTicker);
    const pm = polymarketMap.get(pair.polymarketOutcomeName);
    const kalshiYes = k?.yes;
    const polymarketYes = pm?.yes;

    if (!isPriceValid(kalshiYes)) {
      if (PMCI_DEBUG) {
        console.log(
          `PMCI_DEBUG pair event_id=${pair.polymarketSlug} candidate=${pair.polymarketOutcomeName} spread_insert=skip(kalshi_invalid) ingestPair_will_run=no`,
        );
      }
      console.error(
        `Price sanity: skipping "${pair.eventName}" – kalshi_yes invalid: ${kalshiYes}`,
      );
      continue;
    }
    if (!isPriceValid(polymarketYes)) {
      if (PMCI_DEBUG) {
        console.log(
          `PMCI_DEBUG pair event_id=${pair.polymarketSlug} candidate=${pair.polymarketOutcomeName} spread_insert=skip(poly_invalid) ingestPair_will_run=no`,
        );
      }
      console.error(
        `Price sanity: skipping "${pair.eventName}" – polymarket_yes invalid: ${polymarketYes}`,
      );
      continue;
    }

    const spread = round4(Number(kalshiYes) - Number(polymarketYes));
    const row = {
      event_id: pair.polymarketSlug,
      candidate: pair.polymarketOutcomeName,
      kalshi_yes: round4(Number(kalshiYes)),
      polymarket_yes: round4(Number(polymarketYes)),
      spread,
      observed_at: observedAt,
      source_meta: {
        kalshi_ticker: pair.kalshiTicker,
        polymarket_slug: pair.polymarketSlug,
      },
      kalshi_yes_bid:
        k?.yesBid != null && k.yesBid >= 0 && k.yesBid <= 1 ? round4(k.yesBid) : null,
      kalshi_yes_ask:
        k?.yesAsk != null && k.yesAsk >= 0 && k.yesAsk <= 1 ? round4(k.yesAsk) : null,
      kalshi_open_interest: k?.openInterest != null ? k.openInterest : null,
      kalshi_volume_24h: k?.volume24h != null ? k.volume24h : null,
      polymarket_yes_bid:
        pm?.bestBid != null && pm.bestBid >= 0 && pm.bestBid <= 1
          ? round4(pm.bestBid)
          : null,
      polymarket_yes_ask:
        pm?.bestAsk != null && pm.bestAsk >= 0 && pm.bestAsk <= 1
          ? round4(pm.bestAsk)
          : null,
    };

    const { error } = await supabase.from("prediction_market_spreads").insert(row);
    const spreadInsertOk = !error;
    if (error) {
      if (PMCI_DEBUG) {
        console.log(
          `PMCI_DEBUG pair event_id=${pair.polymarketSlug} candidate=${pair.polymarketOutcomeName} spread_insert=fail ingestPair_will_run=no (skipped after insert error)`,
        );
      }
      console.error(
        `Supabase insert error for ${pair.polymarketOutcomeName}:`,
        error.message,
      );
      cycleErrors.spreadInsertErrors += 1;
      continue;
    }
    console.log(`OK candidate=${pair.polymarketOutcomeName} spread=${spread}`);
    cycleErrors.pairsSucceeded += 1;

    const ingestPairWillRun =
      !!(pmciClientRef?.value && pmciReport && pmciIdsRef?.value);
    if (PMCI_DEBUG) {
      console.log(
        `PMCI_DEBUG pair event_id=${pair.polymarketSlug} candidate=${pair.polymarketOutcomeName} spread_insert=${spreadInsertOk ? "ok" : "fail"} ingestPair_will_run=${ingestPairWillRun ? "yes" : "no"}`,
      );
    }

    if (ingestPairWillRun) {
      try {
        const result = await ingestPair(
          pmciClientRef.value,
          pair,
          k,
          pm,
          observedAt,
          pmciIdsRef.value,
          { snapshotBuffer },
        );
        addIngestionCounts(pmciReport, result);
        if (PMCI_DEBUG) {
          console.log(
            `PMCI_DEBUG result event_id=${pair.polymarketSlug} candidate=${pair.polymarketOutcomeName} markets_upserted=${result?.marketsUpserted ?? 0} snapshots_appended=${result?.snapshotsAppended ?? 0}`,
          );
        }
      } catch (err) {
        if (PMCI_DEBUG) {
          console.error("PMCI_INGEST_ERROR", err.message, err.stack);
        }
        cycleErrors.pmciIngestionErrors += 1;
        const isConnectionError =
          err?.code === "ECONNRESET" ||
          err?.code === "ECONNREFUSED" ||
          (typeof err?.message === "string" &&
            err.message.includes("Connection terminated"));
        if (isConnectionError) {
          pmciClientRef.value = null;
          console.warn(
            "PMCI connection lost mid-cycle. Will attempt reconnect next cycle.",
          );
          continue;
        }
        throw err;
      }
    }
  }
}

async function reconnectPmci(retryState) {
  if (!retryState || retryState.permanentlyDisabled) return null;
  if (!process.env.DATABASE_URL) return null;

  retryState.attempts += 1;
  retryState.lastAttemptAt = new Date().toISOString();
  console.log(
    `PMCI reconnect attempt ${retryState.attempts}/${retryState.maxAttempts}...`,
  );

  let client;
  try {
    client = createPmciClient();
    if (!client) {
      throw new Error("createPmciClient() returned null");
    }
    await client.connect();
    const providerIds = await getProviderIds(client);
    if (!providerIds?.kalshi || !providerIds?.polymarket) {
      await client.end().catch(() => {});
      console.warn("PMCI reconnect failed: providers missing. Run migrations.");
      if (retryState.attempts >= retryState.maxAttempts) {
        retryState.permanentlyDisabled = true;
        console.warn(
          "PMCI ingestion permanently disabled for this run (max retries reached).",
        );
      }
      return { client: null, providerIds: null };
    }
    console.log(
      `PMCI reconnect succeeded on attempt ${retryState.attempts}. Ingestion re-enabled.`,
    );
    retryState.attempts = 0;
    return { client, providerIds };
  } catch (err) {
    if (client) {
      await client.end().catch(() => {});
    }
    console.error(
      `PMCI reconnect attempt ${retryState.attempts}/${retryState.maxAttempts} failed: ${err?.message ?? String(
        err,
      )}`,
    );
    if (retryState.attempts >= retryState.maxAttempts) {
      retryState.permanentlyDisabled = true;
      console.warn(
        "PMCI ingestion permanently disabled for this run (max retries reached).",
      );
    }
    return { client: null, providerIds: null };
  }
}

export async function runObserverCycle({
  pairs,
  supabase,
  pmciClientRef,
  pmciReport,
  pmciIdsRef,
  pmciRetryState,
}) {
  if (pmciClientRef.value === null && pmciRetryState && !pmciRetryState.permanentlyDisabled) {
    const result = await reconnectPmci(pmciRetryState);
    if (result?.client) {
      pmciClientRef.value = result.client;
      pmciIdsRef.value = result.providerIds;
    }
  }
  if (pmciReport) {
    pmciReport.marketsUpserted = 0;
    pmciReport.snapshotsAppended = 0;
  }

  const cycleErrors = {
    cycleAt: new Date().toISOString(),
    pairsAttempted: 0,
    pairsSucceeded: 0,
    pairsConfigured: 0,
    kalshiFetchErrors: 0,
    polymarketFetchErrors: 0,
    spreadInsertErrors: 0,
    pmciIngestionErrors: 0,
    jsonParseErrors: 0,
  };

  if (!pairs?.length) {
    await writeHeartbeat(pmciClientRef.value, cycleErrors);
    if (pmciClientRef?.value && pmciIdsRef?.value) {
      const sweepAt = new Date().toISOString();
      let sweepSnapshotsAppended = 0;
      try {
        const sweep = await runPmciSweep({
          pmciClient: pmciClientRef.value,
          pmciIds: pmciIdsRef.value,
          observedAt: sweepAt,
        });
        sweepSnapshotsAppended = sweep?.snapshotsAppended ?? 0;
        if (sweep.snapshotsAppended > 0) {
          console.log(`PMCI sweep: snapshots_appended=${sweep.snapshotsAppended} markets_covered=${sweep.marketsCovered}`);
        }
      } catch (err) {
        console.warn("PMCI sweep error:", err.message);
      }

      // Freshness cache: bump pmci.providers.last_snapshot_at so the
      // /v1/health/freshness endpoint can see we're alive without scanning
      // provider_market_snapshots. See runtime-status.mjs for the reader side.
      if (sweepSnapshotsAppended > 0) {
        await touchProvidersLastSnapshotAt(pmciClientRef.value, {
          providerIds: [pmciIdsRef.value.kalshi, pmciIdsRef.value.polymarket].filter(Boolean),
          observedAt: sweepAt,
        });
      }

      if (OBSERVER_AUTO_LINK_PASS) {
        try {
          const linkStats = await runAutoLinkPass(pmciClientRef.value);
          if (linkStats.attached > 0 || linkStats.linked > 0) {
            console.log(`PMCI auto-link: attached=${linkStats.attached} linked=${linkStats.linked} examined=${linkStats.examined}`);
          }
        } catch (err) {
          console.warn("PMCI auto-link pass error:", err.message);
        }
      }
    }
    return;
  }

  // Accumulate every pair's snapshots into one buffer and flush at the end
  // of the cycle as a handful of multi-row INSERTs (vs. ~460 single-row
  // INSERTs). See flushSnapshotBuffer / ingestPair(options.snapshotBuffer)
  // for the contract. Sweep snapshots are still written inline by
  // runPmciSweep (bounded, different code path) — only ingestPair pairs are
  // batched here.
  const pairSnapshotBuffer = [];

  const eventGroups = groupPairsByEvent(pairs);
  for (const { eventTicker, slug, pairs: eventPairs } of eventGroups) {
    await runOneCycleForEvent(
      eventTicker,
      slug,
      eventPairs,
      supabase,
      pmciClientRef,
      pmciReport,
      pmciIdsRef,
      cycleErrors,
      pairSnapshotBuffer,
    );
  }

  // Commit the staged snapshots before anything else in the cycle reads
  // them (downstream freshness math, link validation, etc.). If this flush
  // fails we keep the heartbeat write so the run still registers — the
  // freshness cache will correct on the next cycle's flush.
  if (pmciClientRef.value && pairSnapshotBuffer.length > 0) {
    try {
      const flushed = await flushSnapshotBuffer(pmciClientRef.value, pairSnapshotBuffer);
      if (flushed !== pairSnapshotBuffer.length) {
        console.warn(
          `PMCI snapshot flush partial: flushed=${flushed} staged=${pairSnapshotBuffer.length}`,
        );
      }
    } catch (err) {
      console.error("PMCI snapshot flush error:", err.message);
    }
  }

  if (pmciClientRef.value && pmciReport) {
    if (pmciReport.marketsUpserted > 0 || pmciReport.snapshotsAppended > 0) {
      console.log(
        `PMCI ingestion: markets_upserted=${pmciReport.marketsUpserted} snapshots_appended=${pmciReport.snapshotsAppended}`,
      );
    } else if (PMCI_DEBUG) {
      console.log(
        `PMCI_DEBUG cycle totals: markets_upserted=${pmciReport.marketsUpserted} snapshots_appended=${pmciReport.snapshotsAppended}`,
      );
    }
  }

  await writeHeartbeat(pmciClientRef.value, cycleErrors);

  // PMCI sweep: snapshot markets not covered by spread pairs (runs every cycle)
  if (pmciClientRef?.value && pmciIdsRef?.value) {
    const sweepAt = new Date().toISOString();
    let sweepSnapshotsAppended = 0;
    try {
      const sweep = await runPmciSweep({ pmciClient: pmciClientRef.value, pmciIds: pmciIdsRef.value, observedAt: sweepAt });
      sweepSnapshotsAppended = sweep?.snapshotsAppended ?? 0;
      if (sweep.snapshotsAppended > 0) {
        console.log(`PMCI sweep: snapshots_appended=${sweep.snapshotsAppended} markets_covered=${sweep.marketsCovered}`);
      }
      if (sweep.errors > 0) {
        console.warn(`PMCI sweep: errors=${sweep.errors}`);
      }
    } catch (err) {
      console.warn('PMCI sweep error:', err.message);
    }

    // Freshness cache: bump pmci.providers.last_snapshot_at so /v1/health/freshness
    // can read freshness without MAX()-scanning provider_market_snapshots. We
    // fire one UPDATE per cycle after all writes have landed (ingestPair pairs
    // + sweep). See runtime-status.mjs for the reader side.
    const snapshotsWritten = (pmciReport?.snapshotsAppended ?? 0) + sweepSnapshotsAppended;
    if (snapshotsWritten > 0) {
      await touchProvidersLastSnapshotAt(pmciClientRef.value, {
        providerIds: [pmciIdsRef.value.kalshi, pmciIdsRef.value.polymarket].filter(Boolean),
        observedAt: sweepAt,
      });
    }

    if (OBSERVER_AUTO_LINK_PASS) {
      try {
        const linkStats = await runAutoLinkPass(pmciClientRef.value);
        if (linkStats.attached > 0 || linkStats.linked > 0) {
          console.log(`PMCI auto-link: attached=${linkStats.attached} linked=${linkStats.linked} examined=${linkStats.examined}`);
        }
      } catch (err) {
        console.warn("PMCI auto-link pass error:", err.message);
      }
    }
  }
}

