/**
 * D5.2 — Guard before bulk inactivating provider_markets. Call before
 * UPDATE pmci.provider_markets SET status = 'inactive' WHERE ...
 * @param {object} db - pg Client or { query: (sql, params) => Promise }
 * @param {string[]|number[]} marketIds - IDs to check
 * @throws {Error} if any of the markets have live snapshots or links
 */
export async function checkBeforeInactivate(db, marketIds) {
  if (!marketIds?.length) return;
  const ids = marketIds.map((id) => Number(id)).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return;
  const { rows } = await db.query(
    `SELECT pm.id, COUNT(DISTINCT pms.id) AS snapshots, COUNT(DISTINCT ml.id) AS links
     FROM pmci.provider_markets pm
     LEFT JOIN pmci.provider_market_snapshots pms ON pms.provider_market_id = pm.id
     LEFT JOIN pmci.market_links ml ON ml.provider_market_id = pm.id AND ml.status = 'active'
     WHERE pm.id = ANY($1::bigint[])
     GROUP BY pm.id
     HAVING COUNT(DISTINCT pms.id) > 0 OR COUNT(DISTINCT ml.id) > 0`,
    [ids],
  );
  if (rows.length > 0) {
    const idList = rows.map((r) => r.id).join(', ');
    throw new Error(
      `Cannot inactivate ${rows.length} markets — they have live snapshots or links. Review: ${idList}`,
    );
  }
}
