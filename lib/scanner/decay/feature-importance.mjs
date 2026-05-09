/**
 * Binary logistic regression (no external deps) → |coef| importance map.
 */

/**
 * @param {number[]} v
 */
function sigmoid(v) {
  return v.map((x) => {
    if (x >= 0) {
      const z = Math.exp(-x);
      return 1 / (1 + z);
    }
    const z = Math.exp(x);
    return z / (1 + z);
  });
}

/**
 * Matrix n × d (each row features), y length n in {0,1}.
 *
 * @param {number[][]} X
 * @param {number[]} y
 * @param {{ learningRate?: number; iterations?: number; l2?: number }} opts
 * @returns {{ weights: number[]; bias: number }}
 */
export function fitLogisticGd(X, y, opts = {}) {
  const lr = opts.learningRate ?? 0.05;
  const iterations = opts.iterations ?? 3000;
  const l2 = opts.l2 ?? 1e-4;
  if (X.length === 0) throw new Error("fitLogisticGd: empty X");
  const d = X[0].length;
  /** @type {number[]} */
  let w = new Array(d).fill(0);
  let b = 0;
  const n = X.length;

  for (let it = 0; it < iterations; it++) {
    /** @type {number[]} */
    const logits = X.map((row, i) => {
      let s = b;
      for (let j = 0; j < d; j++) s += row[j] * w[j];
      return s;
    });
    const p = sigmoid(logits);
    /** @type {number[]} */
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const err = p[i] - y[i];
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    }
    gb /= n;
    for (let j = 0; j < d; j++) {
      gw[j] = gw[j] / n + l2 * w[j];
      w[j] -= lr * gw[j];
    }
    b -= lr * gb;
  }

  return { weights: w, bias: b };
}

/**
 * Build plain-object importance from feature keys (aligned with X columns).
 *
 * @param {string[]} featureKeys
 * @param {number[]} weights
 * @returns {Record<string, number>}
 */
export function importanceFromWeights(featureKeys, weights) {
  /** @type {Record<string, number>} */
  const out = {};
  for (let i = 0; i < featureKeys.length; i++) {
    out[featureKeys[i]] = Math.abs(weights[i] ?? 0);
  }
  return out;
}
