/**
 * /v1/review/queue, POST /v1/review/decision, POST /v1/resolve/link routes.
 */
export function registerReviewRoutes(app, deps) {
  const { query, withTransaction, SQL, RATE_LIMIT_CONFIG, z } = deps;

  app.get("/v1/review/queue", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      category: z.string().min(1).default("politics"),
      limit: z.coerce.number().int().min(1).max(100).default(1),
      min_confidence: z.coerce.number().min(0).max(1).default(0.88),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const { rows: queueRows } = await query(SQL.review_queue, [
      parsed.data.category,
      parsed.data.min_confidence,
      parsed.data.limit,
    ]);
    if (queueRows.length === 0) return [];

    const marketIds = [
      ...queueRows.map((r) => r.provider_market_id_a),
      ...queueRows.map((r) => r.provider_market_id_b),
    ];
    const { rows: snapRows } = await query(SQL.latest_snapshots_with_raw, [marketIds]);
    const snapByMarket = new Map(snapRows.map((s) => [Number(s.provider_market_id), s]));

    return queueRows.map((r) => {
      const snapA = snapByMarket.get(Number(r.provider_market_id_a));
      const snapB = snapByMarket.get(Number(r.provider_market_id_b));
      const reasons = r.reasons ?? {};
      return {
        proposed_id: Number(r.proposed_id),
        proposed_relationship_type: r.proposed_relationship_type,
        confidence: Number(r.confidence),
        reasons,
        proposal_type: reasons.proposal_type ?? "new_pair",
        target_family_id: reasons.target_family_id != null ? Number(reasons.target_family_id) : undefined,
        created_at: r.created_at,
        market_a: {
          provider: r.provider_code_a,
          provider_market_id: Number(r.provider_market_id_a),
          provider_market_ref: r.ref_a,
          title: r.title_a,
          category: r.category_a,
          status: r.status_a,
          url: r.url_a ?? undefined,
          close_time: r.close_time_a ?? undefined,
          latest_snapshot: snapA
            ? {
                price_yes: snapA.price_yes != null ? Number(snapA.price_yes) : null,
                observed_at: snapA.observed_at,
                price_source: snapA.raw?._pmci?.price_source ?? null,
              }
            : null,
        },
        market_b: {
          provider: r.provider_code_b,
          provider_market_id: Number(r.provider_market_id_b),
          provider_market_ref: r.ref_b,
          title: r.title_b,
          category: r.category_b,
          status: r.status_b,
          url: r.url_b ?? undefined,
          close_time: r.close_time_b ?? undefined,
          latest_snapshot: snapB
            ? {
                price_yes: snapB.price_yes != null ? Number(snapB.price_yes) : null,
                observed_at: snapB.observed_at,
                price_source: snapB.raw?._pmci?.price_source ?? null,
              }
            : null,
        },
      };
    });
  });

  app.post("/v1/review/decision", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      proposed_id: z.number().int().positive(),
      decision: z.enum(["accept", "reject", "skip"]),
      relationship_type: z.enum(["equivalent", "proxy"]),
      note: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return { error: parsed.error.flatten() };

    if (parsed.data.decision === "accept") {
      // All accept writes execute atomically. The FOR UPDATE lock on the proposal
      // row serializes concurrent accept requests and prevents double-accept.
      return await withTransaction(async (txQuery) => {
        const propRes = await txQuery(
          `SELECT id, provider_market_id_a, provider_market_id_b, confidence, reasons, decision
           FROM pmci.proposed_links WHERE id = $1 AND decision IS NULL FOR UPDATE`,
          [parsed.data.proposed_id],
        );
        if (propRes.rowCount === 0) return { error: "proposal_not_found_or_already_decided" };
        const prop = propRes.rows[0];
        const idA = Number(prop.provider_market_id_a);
        const idB = Number(prop.provider_market_id_b);
        const reasons = prop.reasons ?? {};

        const marketRes = await txQuery(
          `SELECT pm.id, pm.provider_id, p.code, pm.provider_market_ref, pm.event_ref
           FROM pmci.provider_markets pm JOIN pmci.providers p ON p.id = pm.provider_id
           WHERE pm.id IN ($1, $2)`,
          [idA, idB],
        );
        const byId = new Map(marketRes.rows.map((r) => [Number(r.id), r]));
        const ma = byId.get(idA);
        const mb = byId.get(idB);
        if (!ma || !mb) return { error: "market_not_found" };

        const isAttach = reasons.proposal_type === "attach_to_family" && reasons.target_family_id != null;
        let familyId = isAttach ? Number(reasons.target_family_id) : null;

        if (!familyId) {
          const topicKey = (mb.event_ref || mb.provider_market_ref || "").split("#")[0].replace(/-/g, " ").split(/\s+/)[0] || "politics";
          const entityKey = reasons.matched_tokens?.[0] || "unknown";
          const label = `politics::${topicKey}::::${entityKey}`;
          const notes = `ref_a=${ma.provider_market_ref} ref_b=${mb.provider_market_ref} review-accepted`;

          const famRes = await txQuery(`SELECT id FROM pmci.market_families WHERE label = $1`, [label]);
          familyId = famRes.rows?.[0]?.id;
          if (!familyId) {
            const ceRes = await txQuery(
              `SELECT id FROM pmci.canonical_events WHERE slug = $1 LIMIT 1`,
              [mb.event_ref?.split("#")[0] || ""],
            );
            const canonicalEventId = ceRes.rows?.[0]?.id ?? null;
            const insFam = await txQuery(
              `INSERT INTO pmci.market_families (label, notes, canonical_event_id) VALUES ($1, $2, $3) RETURNING id`,
              [label, notes, canonicalEventId],
            );
            familyId = insFam.rows?.[0]?.id;
          }
        }

        const nextVer = await txQuery(SQL.next_linker_run_version);
        const version = Number(nextVer.rows[0].next_version);
        await txQuery(SQL.insert_linker_run, [version, isAttach ? "review accept (attach)" : "review accept"]);

        const reasonsJson = JSON.stringify(reasons);
        if (isAttach) {
          const linksInFamily = await txQuery(
            `SELECT provider_market_id FROM pmci.market_links WHERE family_id = $1 AND status = 'active'`,
            [familyId],
          );
          const linkedIds = new Set((linksInFamily.rows || []).map((r) => Number(r.provider_market_id)));
          const toAdd = [idA, idB].filter((id) => !linkedIds.has(id));
          for (const marketId of toAdd) {
            const m = byId.get(marketId);
            if (m) {
              await txQuery(SQL.insert_market_link, [
                familyId,
                m.provider_id,
                marketId,
                parsed.data.relationship_type,
                "active",
                version,
                Number(prop.confidence),
                null,
                null,
                null,
                null,
                null,
                null,
                reasonsJson,
              ]);
            }
          }
        } else {
          await txQuery(SQL.insert_market_link, [
            familyId,
            ma.provider_id,
            idA,
            parsed.data.relationship_type,
            "active",
            version,
            Number(prop.confidence),
            null,
            null,
            null,
            null,
            null,
            null,
            reasonsJson,
          ]);
          await txQuery(SQL.insert_market_link, [
            familyId,
            mb.provider_id,
            idB,
            parsed.data.relationship_type,
            "active",
            version,
            Number(prop.confidence),
            null,
            null,
            null,
            null,
            null,
            null,
            reasonsJson,
          ]);
        }

        await txQuery(
          `UPDATE pmci.proposed_links SET decision = 'accepted', reviewed_at = now(), reviewer_note = $2,
            accepted_family_id = $3, accepted_link_version = $4, accepted_relationship_type = $5 WHERE id = $1`,
          [parsed.data.proposed_id, parsed.data.note ?? "accepted", familyId, version, parsed.data.relationship_type],
        );
        await txQuery(
          `INSERT INTO pmci.review_decisions (proposed_link_id, decision, relationship_type, reviewer_note) VALUES ($1, 'accepted', $2, $3)`,
          [parsed.data.proposed_id, parsed.data.relationship_type, parsed.data.note ?? "accepted"],
        );

        const snapCheck = await txQuery(
          `SELECT COUNT(*)::int AS count
           FROM pmci.provider_market_snapshots s
           JOIN pmci.market_links ml ON ml.provider_market_id = s.provider_market_id
           WHERE ml.family_id = $1
             AND ml.status = 'active'
             AND s.observed_at > now() - interval '1 hour'`,
          [familyId],
        );
        const snapshotCount = snapCheck.rows?.[0]?.count ?? 0;
        const divergenceAvailable = Number(snapshotCount) >= 2;
        return {
          ok: true,
          decision: "accepted",
          family_id: Number(familyId),
          link_version: version,
          divergence_available: divergenceAvailable,
          divergence_note: divergenceAvailable
            ? "Both markets have recent snapshots. Family should appear in /v1/signals/top-divergences."
            : "No recent snapshots for one or both markets yet. Divergence signals will appear after the observer ingests this pair.",
        };
      });
    }

    // reject / skip — two writes must be atomic
    return await withTransaction(async (txQuery) => {
      const propRes = await txQuery(
        `SELECT id FROM pmci.proposed_links WHERE id = $1 AND decision IS NULL FOR UPDATE`,
        [parsed.data.proposed_id],
      );
      if (propRes.rowCount === 0) return { error: "proposal_not_found_or_already_decided" };

      const decision = parsed.data.decision === "reject" ? "rejected" : "skipped";
      await txQuery(
        `UPDATE pmci.proposed_links SET decision = $2, reviewed_at = now(), reviewer_note = $3 WHERE id = $1`,
        [parsed.data.proposed_id, decision, parsed.data.note ?? null],
      );
      await txQuery(
        `INSERT INTO pmci.review_decisions (proposed_link_id, decision, reviewer_note) VALUES ($1, $2, $3)`,
        [parsed.data.proposed_id, decision, parsed.data.note ?? null],
      );
      return { ok: true, decision };
    });
  });

  app.post("/v1/resolve/link", { rateLimit: RATE_LIMIT_CONFIG }, async (req) => {
    const schema = z.object({
      family_id: z.number().int().positive(),
      provider_code: z.enum(["kalshi", "polymarket"]),
      provider_market_id: z.number().int().positive(),
      relationship_type: z.enum(["identical", "equivalent", "proxy", "correlated"]),
      confidence: z.number().min(0).max(1),
      reasons: z.record(z.any()).default({}),
      correlation_window: z.string().optional(),
      lag_seconds: z.number().int().optional(),
      correlation_strength: z.number().min(-1).max(1).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return { error: parsed.error.flatten() };

    const adminKey = process.env.PMCI_ADMIN_KEY;
    if (adminKey && req.headers["x-pmci-admin-key"] !== adminKey) {
      return { error: "unauthorized" };
    }

    // linker_run insert + market_link upsert are atomic
    return await withTransaction(async (txQuery) => {
      const prov = await txQuery("select id from pmci.providers where code = $1", [parsed.data.provider_code]);
      if (prov.rowCount === 0) return { error: "unknown_provider" };
      const providerId = prov.rows[0].id;

      const next = await txQuery(SQL.next_linker_run_version);
      const version = Number(next.rows[0].next_version);
      await txQuery(SQL.insert_linker_run, [version, "manual resolve/link"]);

      const res = await txQuery(SQL.insert_market_link, [
        parsed.data.family_id,
        providerId,
        parsed.data.provider_market_id,
        parsed.data.relationship_type,
        "active",
        version,
        parsed.data.confidence,
        parsed.data.correlation_window ?? null,
        parsed.data.lag_seconds ?? null,
        parsed.data.correlation_strength ?? null,
        null,
        null,
        null,
        JSON.stringify(parsed.data.reasons ?? {}),
      ]);

      const row = res.rows[0];
      return { link_id: Number(row.id), link_version: Number(row.link_version), status: row.status };
    });
  });
}
