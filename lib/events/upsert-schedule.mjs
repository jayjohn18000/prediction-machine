/**
 * Phase G: write external schedule rows into pmci.canonical_events.
 * Idempotent on (external_source, external_ref) via upsert on slug + conflict targets.
 */

/**
 * @param {import('pg').Client} client
 * @param {object} row - normalized row from normalizeSportsDbEvent (or compatible)
 * @returns {Promise<string|null>} canonical_events.id uuid
 */
export async function upsertCanonicalEventRow(client, row) {
  if (!client || !row?.slug || !row?.title || !row?.category) return null;

  const participantsJson = JSON.stringify(row.participants ?? []);
  const metadataJson = JSON.stringify(row.metadata ?? {});

  const res = await client.query(
    `INSERT INTO pmci.canonical_events (
       slug, title, category, description, start_time, end_time, resolution_source, metadata,
       subcategory, event_date, event_time, participants, external_ref, external_source,
       source_annotation
     ) VALUES (
       $1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::jsonb,
       $9, $10::date, $11::timestamptz, $12::jsonb, $13, $14,
       'schedule_ingest'
     )
     ON CONFLICT (slug) DO UPDATE SET
       title = EXCLUDED.title,
       subcategory = COALESCE(EXCLUDED.subcategory, pmci.canonical_events.subcategory),
       event_date = COALESCE(EXCLUDED.event_date, pmci.canonical_events.event_date),
       event_time = COALESCE(EXCLUDED.event_time, pmci.canonical_events.event_time),
       participants = CASE
         WHEN EXCLUDED.participants::text != '[]' THEN EXCLUDED.participants
         ELSE pmci.canonical_events.participants
       END,
       external_ref = COALESCE(EXCLUDED.external_ref, pmci.canonical_events.external_ref),
       external_source = COALESCE(EXCLUDED.external_source, pmci.canonical_events.external_source),
       metadata = COALESCE(pmci.canonical_events.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb),
       updated_at = now()
     RETURNING id`,
    [
      row.slug,
      row.title,
      row.category,
      row.description ?? null,
      row.start_time ?? row.event_time ?? null,
      row.end_time ?? null,
      row.resolution_source ?? null,
      metadataJson,
      row.subcategory ?? null,
      row.event_date ?? null,
      row.event_time ?? null,
      participantsJson,
      row.external_ref ?? null,
      row.external_source ?? null,
    ],
  );
  return res.rows?.[0]?.id ?? null;
}

/**
 * @param {import('pg').Client} client
 * @param {object[]} rows
 */
export async function upsertCanonicalEventBatch(client, rows) {
  let n = 0;
  for (const r of rows) {
    const id = await upsertCanonicalEventRow(client, r);
    if (id) n++;
  }
  return n;
}
