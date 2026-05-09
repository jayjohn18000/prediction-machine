import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeAbsDwpDt, eventWpDelta } from "../../../lib/mm/gates/game-state.mjs";

const _d = dirname(fileURLToPath(import.meta.url));
const hoopCoef = JSON.parse(readFileSync(join(_d, "../../../lib/mm/gates/hoopR-coefficients.json"), "utf8"));

test("dWP/dt helper matches fixture-shaped actions", () => {
  const actions = [
    { actionType: "2pt" },
    { actionType: "2pt" },
    { actionType: "3PT" },
  ];
  const d = computeAbsDwpDt(actions, 8);
  assert.ok(d > 0);
  assert.ok(eventWpDelta("3PT", hoopCoef) > eventWpDelta("SUB", hoopCoef));
});

test("gameStatePullCheck uses fetch mock", async () => {
  const { gameStatePullCheck } = await import("../../../lib/mm/gates/game-state.mjs");
  const payload = {
    game: {
      actions: Array.from({ length: 12 }, () => ({ actionType: "3PT" })),
    },
  };
  const fetchMock = async () => ({
    ok: true,
    json: async () => payload,
  });
  const r = await gameStatePullCheck(
    { game_state_pull_enabled: true, nba_game_id: "0022300001" },
    /** @type {any} */ (fetchMock),
    { p75Baseline: 0.001 },
  );
  assert.equal(r.pull, true);
});
