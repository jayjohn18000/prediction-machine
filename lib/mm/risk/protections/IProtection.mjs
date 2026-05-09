/**
 * Freqtrade-style protection hook surface.
 *
 * @typedef {'halt'|'one_sided_flatten'|'halve_size'|'cooldown_10min'} StopKind
 * @typedef {{ stop: StopKind, reason : string } | false} StopResult
 */

export class IProtection {
  /** @param {Record<string, unknown>} _state @returns {StopResult} */
  globalStop(_state) {
    return false;
  }

  /** @param {Record<string, unknown>} _state @param {string} _marketTicker @returns {StopResult} */
  stopPerMarket(_state, _marketTicker) {
    return false;
  }

  /** @param {Record<string, unknown>} _state @param {string} _marketTicker @param {string} _side @returns {StopResult} */
  stopPerSide(_state, _marketTicker, _side) {
    return false;
  }
}
