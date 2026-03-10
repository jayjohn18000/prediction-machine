/**
 * Provider repository helpers.
 */

export async function resolveProviderIdByCode(queryFn, providerCode) {
  const provRes = await queryFn("select id from pmci.providers where code = $1", [providerCode]);
  if (provRes.rowCount === 0) return null;
  return provRes.rows[0].id;
}
