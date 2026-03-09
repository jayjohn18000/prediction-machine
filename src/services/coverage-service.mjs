export async function getCoverage({ query, resolveProviderIdByCode, SQL, providerCode, category }) {
  const providerId = await resolveProviderIdByCode(query, providerCode);
  if (providerId == null) return { error: "unknown_provider" };

  const categoryOrNull = category ?? null;
  const cov = await query(SQL.coverage, [providerId, categoryOrNull]);
  const row = cov.rows[0];

  return {
    provider: providerCode,
    category: categoryOrNull,
    total_markets: Number(row.total_markets),
    matched_markets: Number(row.matched_markets),
    coverage_ratio: Number(row.coverage_ratio),
    unmatched_breakdown: row.unmatched_breakdown ?? [],
  };
}

export async function getCoverageSummary({ query, resolveProviderIdByCode, parseSince, SQL, providerCode, category, since }) {
  const providerId = await resolveProviderIdByCode(query, providerCode);
  if (providerId == null) return { error: "unknown_provider" };

  const categoryOrNull = category ?? null;
  const sinceDate = parseSince(since);
  const sinceTs = sinceDate ? sinceDate.toISOString() : null;

  const { rows } = await query(SQL.coverage_summary, [providerId, categoryOrNull, sinceTs]);
  const row = rows[0];

  return {
    provider: providerCode,
    category: categoryOrNull ?? undefined,
    since: since ?? undefined,
    total_markets: Number(row.total_markets),
    linked_markets: Number(row.linked_markets),
    unlinked_markets: Number(row.unlinked_markets),
    coverage_ratio: Number(row.coverage_ratio),
  };
}
