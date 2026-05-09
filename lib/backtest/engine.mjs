import { createPgClient } from "../mm/order-store.mjs";
import { kalshiFeeCentsForMmFill, spreadCaptureCentsForFill } from "../mm/pnl-attribution.mjs";
import { BacktestState } from "./state.mjs";
import { openSnapshotCursor, normalizeProviderSnapshotRow, resolveKalshiProviderMarketId } from "./snapshot-cursor.mjs";
import { simulateFill } from "./fill-sim.mjs";
import { deriveQuotesForSnapshot } from "./quote-engine.mjs";

function adverseOneTick(fill, midCents) {
  if (midCents == null || !Number.isFinite(midCents)) return 0;
  const P = Number(fill.priceCents);
  const sz = Number(fill.size);
  const s = String(fill.side ?? "");
  if (s === "yes_buy") return Math.max(0, (P - midCents) * sz);
  if (s === "yes_sell") return Math.max(0, (midCents - P) * sz);
  return 0;
}

async function loadHypothesisRow(client, hypothesisId) {
  const r = await client.query(`SELECT * FROM pmci.hypotheses WHERE id = $1 LIMIT 1`, [hypothesisId]);
  const row = r.rows[0];
  if (!row) throw new Error(`hypothesis not found: ${hypothesisId}`);
  return row;
}

async function insertFill(client, runId, observedAt, fill, pnlC) {
  await client.query(
    `
    INSERT INTO pmci.backtest_fills (
      run_id, snapshot_ts, side, price, size_c, fill_type, pnl_c
    ) VALUES (
      $1::bigint, $2::timestamptz, $3, $4::numeric, $5::int, $6, $7::numeric
    )
    `,
    [
      runId,
      observedAt,
      fill.side,
      fill.priceCents / 100,
      Math.round(fill.size),
      fill.maker ? "maker" : "taker",
      pnlC,
    ],
  );
}

export async function runBacktest(opts) {
  const {
    hypothesisId,
    marketTicker,
    startAt,
    endAt,
    connectionString = process.env.DATABASE_URL?.trim(),
  } = opts;

  if (!connectionString) throw new Error("DATABASE_URL required");

  const client = createPgClient(connectionString);
  await client.connect();
  let runId = null;

  try {
    const hypothesis = await loadHypothesisRow(client, hypothesisId);
    const testCap = Math.max(
      1000,
      Number(
        hypothesis.sizing_rules?.test_capital_c ??
          hypothesis.sizing_rules?.per_trade_size_c ??
          hypothesis.max_position_size_c ??
          10_000,
      ),
    );
    const state = new BacktestState({ initialCapitalC: testCap, marketTicker });

    const startMs = new Date(startAt).getTime();
    const endMs = new Date(endAt).getTime();
    if (endMs - startMs < 6.5 * 86400_000) {
      console.warn("backtest: window shorter than 7 days — acceptance may fail");
    }

    const paramsSnapshot = JSON.parse(
      JSON.stringify(hypothesis, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    );

    const ins = await client.query(
      `
      INSERT INTO pmci.backtest_runs (
        hypothesis_id, market_ticker, start_at, end_at, params_snapshot,
        spread_capture_c, adverse_c, fee_net_c, fill_rate, n_quotes, n_fills
      ) VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::jsonb,
        0, 0, 0, 0, 0, 0)
      RETURNING id
      `,
      [hypothesisId, marketTicker, startAt, endAt, paramsSnapshot],
    );
    runId = Number(ins.rows[0].id);

    const providerMarketId = await resolveKalshiProviderMarketId(client, marketTicker);
    const cursor = await openSnapshotCursor(client, { providerMarketId, startAt, endAt });

    let prevNorm = null;
    let prevObservedMs = null;
    const fvByMarket = {};
    const midDeque = [];
    let pendingMarkoutFill = null;
    let hits = 0;
    let hitDen = 0;
    let resting = [];
    let lastTakerMs = 0;

    let batch;
    while ((batch = await cursor.next(300)).length > 0) {
      for (const row of batch) {
        const norm = normalizeProviderSnapshotRow(row);
        if (norm.midCents == null || !Number.isFinite(norm.midCents)) continue;

        state.updateMarket({ observedAt: norm.observedAt });
        if (pendingMarkoutFill) {
          state.applyAdverseCents(adverseOneTick(pendingMarkoutFill, norm.midCents));
          pendingMarkoutFill = null;
        }
        if (state.haltedToday) continue;
        if (state.shouldHaltOnDailyDrawdown()) {
          state.haltDay();
          continue;
        }

        if (prevNorm?.midCents != null) {
          const still = [];
          for (const o of resting) {
            const f = simulateFill(
              { ...o, prevMidCents: prevNorm.midCents, curMidCents: norm.midCents },
              norm,
              true,
            );
            if (f) {
              const fee = kalshiFeeCentsForMmFill({
                side: f.side,
                price_cents: f.priceCents,
                size_contracts: f.size,
                liquidityRole: "maker",
              });
              const sp = spreadCaptureCentsForFill(
                f.side,
                o.fairAtPlace ?? norm.midCents,
                f.priceCents,
                f.size,
              );
              const net = sp - fee;
              state.applyFill(
                { side: f.side, maker: true, snapshot_ts: norm.observedAt, size_c: f.size },
                net,
                sp,
                0,
              );
              state.feeNetC += fee;
              pendingMarkoutFill = f;
              hitDen += 1;
              if (
                (f.side === "yes_buy" && norm.midCents > f.priceCents) ||
                (f.side === "yes_sell" && norm.midCents < f.priceCents)
              )
                hits += 1;
              await insertFill(client, runId, norm.observedAt, f, net);
            } else still.push(o);
          }
          resting = still;
        }

        const plan = deriveQuotesForSnapshot({
          hypothesis,
          book: norm,
          backtestState: state,
          fvByMarket,
          prevObservedMs,
          midDeque,
          ticker: marketTicker,
        });
        prevObservedMs = norm.observedMs;
        prevNorm = norm;
        resting = plan.resting ?? [];
        if ((plan.resting?.length ?? 0) > 0 || (plan.takers?.length ?? 0) > 0) state.nQuotes += 1;

        for (const t of plan.takers ?? []) {
          const cdMs = Math.min(
            900_000,
            Math.max(30_000, Number(hypothesis.risk_gates?.cooldown_after_3_same_side_fills_seconds ?? 60) * 1000),
          );
          if (norm.observedMs - lastTakerMs < cdMs) continue;
          const f = simulateFill(t, norm, true);
          if (!f) continue;
          lastTakerMs = norm.observedMs;
          const fee = kalshiFeeCentsForMmFill({
            side: f.side,
            price_cents: f.priceCents,
            size_contracts: f.size,
            liquidityRole: "taker",
          });
          const sp = spreadCaptureCentsForFill(
            f.side,
            t.fairAtPlace ?? norm.midCents,
            f.priceCents,
            f.size,
          );
          const net = sp - fee;
          state.applyFill({ side: f.side, maker: false, snapshot_ts: norm.observedAt, size_c: f.size }, net, sp, 0);
          state.feeNetC += fee;
          pendingMarkoutFill = f;
          hitDen += 1;
          if (
            (f.side === "yes_buy" && norm.midCents > f.priceCents) ||
            (f.side === "yes_sell" && norm.midCents < f.priceCents)
          )
            hits += 1;
          await insertFill(client, runId, norm.observedAt, f, net);
        }
      }
    }

    await cursor.close();

    const minutes = Math.max(1, (endMs - startMs) / 60_000);
    const density = state.snapshotCount / minutes;
    const fillRate = state.nQuotes > 0 ? state.nFills / state.nQuotes : 0;
    const netEdge = state.spreadCaptureC - state.adverseC - state.feeNetC;

    await client.query(
      `
      UPDATE pmci.backtest_runs SET
        spread_capture_c = $2::numeric,
        adverse_c = $3::numeric,
        fee_net_c = $4::numeric,
        fill_rate = $5::numeric,
        n_fills = $6::int,
        n_quotes = $7::int
      WHERE id = $1::bigint
      `,
      [runId, state.spreadCaptureC, state.adverseC, state.feeNetC, fillRate, state.nFills, state.nQuotes],
    );

    const hitRate = hitDen > 0 ? hits / hitDen : 0;
    const maxDdPct = Math.abs(Math.min(0, state.dailyDrawdown));
    const valid =
      state.nQuotes >= 100 && endMs - startMs >= 6.5 * 86400_000 && density >= 0.95;
    const pass = netEdge > 0 && hitRate > 0.55 && maxDdPct < 0.15;

    return {
      runId,
      state,
      density,
      fillRate,
      netEdge,
      hitRate,
      valid,
      pass,
      acceptance: {
        nQuotes: state.nQuotes,
        density,
        windowDays: (endMs - startMs) / 86400_000,
        nFills: state.nFills,
      },
    };
  } finally {
    await client.end().catch(() => {});
  }
}
