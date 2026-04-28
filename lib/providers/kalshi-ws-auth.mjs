/**
 * Kalshi WebSocket + REST authentication — RSA-PSS signer.
 *
 * Spec (verified 2026-04-24 against docs.kalshi.com/getting_started/quick_start_websockets):
 *   - Sign string: `{unix_ms_ts}{METHOD}{PATH}` where PATH has no query params.
 *   - Algorithm: RSA-PSS with SHA-256, MGF1 SHA-256, salt length = digest length.
 *   - Headers sent on connection:
 *       KALSHI-ACCESS-KEY:       the public key id from demo.kalshi.co account settings
 *       KALSHI-ACCESS-SIGNATURE: base64(RSA-PSS-sign(sign_string, private_key))
 *       KALSHI-ACCESS-TIMESTAMP: unix ms as string
 *
 * Used by:
 *   - lib/ingestion/depth.mjs (MM MVP W1)
 *   - lib/providers/kalshi-trader.mjs (W2+, not yet implemented)
 *
 * Private key sourcing (pick one, per .env.example):
 *   - KALSHI_DEMO_PRIVATE_KEY_PATH: filesystem path to the PEM file
 *   - KALSHI_DEMO_PRIVATE_KEY:      inline PEM contents (for Fly secrets deployment)
 *
 * Pure module — no network, no I/O except reading the PEM when path form is used.
 */

import crypto from "node:crypto";
import fs from "node:fs";

/**
 * Load an RSA private key from either an inline PEM string or a filesystem path.
 * Inline form allows escaped newlines (`\n`) so env-var deployment works.
 *
 * @param {{ path?: string, inline?: string }} opts
 * @returns {crypto.KeyObject}
 */
export function loadPrivateKey({ path, inline } = {}) {
  let pem;
  if (inline && inline.length > 0) {
    pem = inline.replace(/\\n/g, "\n");
  } else if (path && path.length > 0) {
    pem = fs.readFileSync(path, "utf8");
  } else {
    throw new Error(
      "Kalshi auth: must provide either KALSHI_DEMO_PRIVATE_KEY (inline PEM) " +
      "or KALSHI_DEMO_PRIVATE_KEY_PATH (filesystem path).",
    );
  }
  return crypto.createPrivateKey({ key: pem, format: "pem" });
}

/**
 * Build the Kalshi signature for a given method + path pair.
 * Pure function — returns signature bytes and timestamp string; caller composes headers.
 *
 * @param {{ privateKey: crypto.KeyObject, method?: string, path?: string, timestampMs?: number }} opts
 * @returns {{ timestamp: string, signatureBase64: string, signString: string }}
 */
export function signRequest({ privateKey, method = "GET", path = "/trade-api/ws/v2", timestampMs = Date.now() }) {
  const timestamp = String(timestampMs);
  const signString = `${timestamp}${method}${path}`;
  const signature = crypto.sign(
    "sha256",
    Buffer.from(signString, "utf8"),
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      mgf1Hash: "sha256",
    },
  );
  return {
    timestamp,
    signatureBase64: signature.toString("base64"),
    signString,
  };
}

/**
 * Build full header set for a Kalshi WebSocket handshake on the default path.
 *
 * @param {{ privateKey: crypto.KeyObject, keyId: string, path?: string, timestampMs?: number }} opts
 * @returns {{ headers: Record<string,string> }}
 */
export function buildWSHandshakeHeaders({ privateKey, keyId, path = "/trade-api/ws/v2", timestampMs }) {
  if (!keyId || keyId.length === 0) {
    throw new Error("Kalshi auth: keyId required (KALSHI_DEMO_API_KEY_ID).");
  }
  const { timestamp, signatureBase64 } = signRequest({ privateKey, method: "GET", path, timestampMs });
  return {
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": signatureBase64,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    },
  };
}
