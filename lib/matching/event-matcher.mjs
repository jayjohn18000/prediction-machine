/**
 * Phase G: attach provider_markets to canonical_events (event-first matching).
 * Full scoring (teams, politics, crypto) expands here in later steps.
 */

/**
 * @param {import('pg').Client} client
 * @param {{ category: string, dateFrom: string, dateTo: string, subcategory?: string }} q
 */
export async function findCanonicalEventsInDateWindow(client, q) {
  if (!client || !q?.category || !q?.dateFrom || !q?.dateTo) return [];
  const params = [q.category, q.dateFrom, q.dateTo];
  let sql = `
    SELECT id, slug, title, category, subcategory, event_date, event_time, participants, external_ref, external_source
    FROM pmci.canonical_events
    WHERE category = $1
      AND event_date IS NOT NULL
      AND event_date >= $2::date
      AND event_date <= $3::date
  `;
  if (q.subcategory) {
    params.push(q.subcategory);
    sql += ` AND subcategory = $4`;
  }
  sql += ` ORDER BY event_date ASC, title ASC`;
  const res = await client.query(sql, params);
  return res.rows ?? [];
}

/**
 * Placeholder confidence scorer — returns 0 until team / entity normalization lands.
 * @param {{ participants: object[], home_team?: string, away_team?: string }} _event
 * @param {{ home_team?: string, away_team?: string, title?: string }} _market
 */
export function scoreEventAttachment(_event, _market) {
  return 0;
}
