export class BacktestState {
  constructor(opts = {}) {
    this.initialCapitalC = Number(opts.initialCapitalC ?? 10_000);
    this.marketTicker = opts.marketTicker ?? "";
    this.cash_c = Number(opts.initialCapitalC ?? 10_000);
    this.inventory = {};
    this.restingOrders = [];
    this.dailyPnlCents = 0;
    this.dailyPeakC = this.initialCapitalC;
    this.dailyDrawdown = 0;
    this.cooldowns = {};
    this.haltedToday = false;
    this.fillHistory = [];
    this._fillHistoryMax = 200;
    this.snapshotCount = 0;
    this.nQuotes = 0;
    this.nFills = 0;
    this.spreadCaptureC = 0;
    this.adverseC = 0;
    this.feeNetC = 0;
    this._dayUtc = null;
  }

  _rollDaily(snapshotTs) {
    const d = new Date(snapshotTs);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if (this._dayUtc !== key) {
      this._dayUtc = key;
      this.dailyPnlCents = 0;
      this.dailyPeakC = this.cash_c;
      this.dailyDrawdown = 0;
      this.haltedToday = false;
    }
  }

  updateMarket(snap) {
    this._rollDaily(snap.observedAt);
    this.snapshotCount += 1;
  }

  netContractsFor(ticker = this.marketTicker) {
    return Number(this.inventory[ticker] ?? 0);
  }

  addRestingOrder(order) {
    this.restingOrders.push(order);
  }

  clearResting() {
    this.restingOrders = [];
  }

  applyFill(fill, deltaCash, spreadPart, adversePart) {
    this._rollDaily(fill.snapshot_ts);
    this.cash_c += deltaCash;
    this.spreadCaptureC += spreadPart;
    this.adverseC += adversePart;
    this.nFills += 1;
    this.dailyPnlCents += deltaCash;
    if (this.cash_c > this.dailyPeakC) this.dailyPeakC = this.cash_c;
    const dd = (this.cash_c - this.dailyPeakC) / Math.max(1, this.initialCapitalC);
    if (dd < this.dailyDrawdown) this.dailyDrawdown = dd;
    this.fillHistory.push({ side: fill.side, maker: fill.maker });
    if (this.fillHistory.length > this._fillHistoryMax) this.fillHistory.shift();
    const t = this.marketTicker;
    const sz = Number(fill.size_c ?? 0);
    const side = String(fill.side ?? "");
    if (side === "yes_buy") this.inventory[t] = (this.inventory[t] ?? 0) + sz;
    else if (side === "yes_sell") this.inventory[t] = (this.inventory[t] ?? 0) - sz;
  }

  haltDay() {
    this.haltedToday = true;
    this.clearResting();
  }

  applyAdverseCents(adv) {
    const a = Number(adv);
    if (!Number.isFinite(a) || a === 0) return;
    this.adverseC += Math.max(0, a);
    this.cash_c -= a;
    this.dailyPnlCents -= a;
    if (this.cash_c > this.dailyPeakC) this.dailyPeakC = this.cash_c;
    const dd = (this.cash_c - this.dailyPeakC) / Math.max(1, this.initialCapitalC);
    if (dd < this.dailyDrawdown) this.dailyDrawdown = dd;
  }

  shouldHaltOnDailyDrawdown() {
    return this.dailyDrawdown <= -0.03;
  }
}
