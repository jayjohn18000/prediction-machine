export async function listProviders({ query, SQL }) {
  const { rows } = await query(SQL.providers);
  return rows.map((r) => ({ code: r.code, name: r.name }));
}

export async function listCanonicalEvents({ query, SQL, category }) {
  const { rows } = await query(SQL.canonical_events, [category ?? null]);
  return rows;
}

export async function getUnlinkedMarkets({ query, resolveProviderIdByCode, parseSince, SQL, providerCode, category, since, limit }) {
  const providerId = await resolveProviderIdByCode(query, providerCode);
  if (providerId == null) return { error: "unknown_provider" };

  const categoryOrNull = category ?? null;
  const sinceDate = parseSince(since);
  const sinceTs = sinceDate ? sinceDate.toISOString() : null;

  const { rows } = await query(SQL.unlinked_markets, [providerId, categoryOrNull, sinceTs, limit]);

  return rows.map((r) => ({
    provider: providerCode,
    provider_market_id: Number(r.provider_market_id),
    provider_market_ref: r.provider_market_ref,
    title: r.title,
    category: r.category,
    status: r.status,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    url: r.url ?? undefined,
  }));
}

export async function getNewMarkets({ query, resolveProviderIdByCode, parseSince, SQL, providerCode, category, since, limit }) {
  const sinceDate = parseSince(since);
  if (!sinceDate) {
    return { error: "invalid_since", message: "since must be ISO date or relative e.g. 24h, 7d" };
  }

  const providerId = await resolveProviderIdByCode(query, providerCode);
  if (providerId == null) return { error: "unknown_provider" };

  const categoryOrNull = category ?? null;
  const sinceTs = sinceDate.toISOString();

  const { rows } = await query(SQL.new_markets, [providerId, categoryOrNull, sinceTs, limit]);

  return rows.map((r) => ({
    provider: providerCode,
    provider_market_id: Number(r.provider_market_id),
    provider_market_ref: r.provider_market_ref,
    title: r.title,
    category: r.category,
    status: r.status,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    url: r.url ?? undefined,
  }));
}
