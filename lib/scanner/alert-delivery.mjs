/** @typedef {import('pg').Client | import('pg').PoolClient} PgConn */

/**
 * Compute next eligible time from zero-based attempt index (1s, 5s, 25s gaps).
 * @param {number} attemptsAfterFailure
 */
export function backoffMs(attemptsAfterFailure) {
  if (attemptsAfterFailure <= 0) return 0;
  if (attemptsAfterFailure === 1) return 1000;
  if (attemptsAfterFailure === 2) return 5000;
  return 25000;
}

function buildMessageBody(row) {
  const tradable = row.tradable === false ? "tradable: false (dim in UI)\n" : "";
  const base = row.body ?? row.message ?? row.payload?.text ?? JSON.stringify(row.payload ?? {});
  return `${tradable}${base}`;
}

/**
 * @param {PgConn} client
 * @param {string} hypothesisId
 * @param {number} excludeId
 */
async function hourlyDeliveryCount(client, hypothesisId, excludeId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS c FROM pmci.alerts
     WHERE hypothesis_id::text = $1
       AND delivered_at IS NOT NULL
       AND delivered_at > now() - interval '1 hour'
       AND id <> $2`,
    [hypothesisId, excludeId],
  );
  return rows[0]?.c ?? 0;
}

/**
 * @param {PgConn} client
 * @param {{ id: unknown, webhook_target?: unknown }} row
 */
async function deliverWebhook(row) {
  const targetRaw = row.webhook_target ?? row.channel ?? {};
  let target = {};
  if (typeof targetRaw === "string") {
    try {
      target = JSON.parse(targetRaw || "{}");
    } catch {
      target = {};
    }
  } else {
    target = targetRaw ?? {};
  }
  const bodyText = typeof row.body === "string" ? row.body : buildMessageBody(row);
  const type = String(target.type ?? "").toLowerCase();

  if (type === "slack") {
    const url = target.url ?? target.webhook_url;
    if (!url) throw new Error("slack webhook missing url");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: bodyText.slice(0, 15000) }),
    });
    if (!res.ok) throw new Error(`slack ${res.status}`);
    return `slack:${res.status}`;
  }

  if (type === "email") {
    const { sendMailConfigured } = await import("./smtp-send.mjs");
    const to = target.to ?? target.email;
    if (!to) throw new Error("email missing to");
    const subj =
      typeof row.subject === "string"
        ? row.subject
        : `PMCI alert #${String(row.id)}`;
    await sendMailConfigured({
      to: String(to),
      subject: subj.slice(0, 200),
      text: bodyText.slice(0, 20000),
    });
    return `email:${to}`;
  }

  if (type === "http" || type === "https" || type === "post") {
    const url = target.url;
    if (!url) throw new Error("http target missing url");
    const headers = target.headers ?? { "Content-Type": "application/json" };
    const res = await fetch(url, {
      method: target.method ?? "POST",
      headers,
      body: target.body_raw ?? JSON.stringify({ text: bodyText }),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return `http:${res.status}`;
  }

  throw new Error(`unknown webhook target type '${type}'`);
}

/**
 * @param {PgConn} client
 * @returns {Promise<{ processed: number, delivered: number, deferred: number, failed: number, errors: string[] }>}
 */
export async function runAlertDeliveryRound(client) {
  let processed = 0;
  let delivered = 0;
  let deferred = 0;
  let failed = 0;
  const errors = [];

  let pending;
  try {
    const r = await client.query(
      `SELECT id,
              hypothesis_id,
              hypothesis_id::text AS hypothesis_text,
              webhook_target,
              fired_at,
              delivered_at,
              delivery_status,
              COALESCE(delivery_attempts, 0)::int AS delivery_attempts,
              last_attempt_at,
              body,
              subject,
              tradable
       FROM pmci.alerts
       WHERE delivered_at IS NULL
         AND COALESCE(delivery_status, '') NOT IN ('batched_hourly_digest', 'abandoned')
       ORDER BY fired_at ASC NULLS LAST
       LIMIT 40`,
    );
    pending = r.rows;
  } catch (e) {
    errors.push(`load_alerts: ${/** @type {Error} */ (e).message}`);
    return { processed, delivered, deferred, failed, errors };
  }

  const nowMs = Date.now();
  for (const row of pending) {
    processed += 1;
    const id = row.id;
    const hypothesisId = row.hypothesis_text ?? String(row.hypothesis_id);
    const attempts = Number(row.delivery_attempts ?? 0);

    if (row.last_attempt_at) {
      const last = new Date(row.last_attempt_at).getTime();
      const needGap = backoffMs(attempts);
      if (nowMs - last < needGap) continue;
    }

    try {
      const n = await hourlyDeliveryCount(client, hypothesisId, Number(id));
      if (n >= 10) {
        await client.query(
          `UPDATE pmci.alerts
           SET delivery_status = 'batched_hourly_digest',
               delivered_at = now(),
               last_attempt_at = now()
           WHERE id = $1`,
          [id],
        );
        deferred += 1;
        continue;
      }

      await deliverWebhook(row);
      await client.query(
        `UPDATE pmci.alerts
         SET delivered_at = now(),
             delivery_status = 'delivered',
             last_attempt_at = now()
         WHERE id = $1`,
        [id],
      );
      delivered += 1;
    } catch (e) {
      const msg = /** @type {Error} */ (e).message;
      errors.push(`id=${String(id)}: ${msg}`);
      const nextAttempts = attempts + 1;
      if (nextAttempts >= 3) {
        failed += 1;
        await client.query(
          `UPDATE pmci.alerts
           SET delivery_status = 'abandoned',
               delivery_attempts = $2,
               last_attempt_at = now()
           WHERE id = $1`,
          [id, nextAttempts],
        );
      } else {
        await client.query(
          `UPDATE pmci.alerts
           SET delivery_attempts = $2,
               delivery_status = 'retry',
               last_attempt_at = now()
           WHERE id = $1`,
          [id, nextAttempts],
        );
      }
    }
  }

  return { processed, delivered, deferred, failed, errors };
}
