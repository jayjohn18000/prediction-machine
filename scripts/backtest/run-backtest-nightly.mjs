#!/usr/bin/env node
import "dotenv/config";
import { runBacktestNightly } from "../../lib/backtest/nightly.mjs";

runBacktestNightly()
  .then((out) => {
    console.log(JSON.stringify(out, null, 2));
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
