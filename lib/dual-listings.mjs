import { normalizeSlug } from './events-schema.mjs';

/**
 * Match canonical events from two providers by normalized title and region.
 *
 * @param {import('./events-schema.mjs').CanonicalEvent[]} fromA
 * @param {import('./events-schema.mjs').CanonicalEvent[]} fromB
 * @returns {{ left: import('./events-schema.mjs').CanonicalEvent, right: import('./events-schema.mjs').CanonicalEvent }[]}
 */
export function matchCanonicalEvents(fromA, fromB) {
  const out = [];
  const index = new Map();

  for (const ev of fromB) {
    const key = `${normalizeSlug(ev.title)}|${(ev.region || '').toLowerCase()}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(ev);
  }

  for (const ev of fromA) {
    const key = `${normalizeSlug(ev.title)}|${(ev.region || '').toLowerCase()}`;
    const candidates = index.get(key);
    if (candidates && candidates.length > 0) {
      // For now, pick the first match; can be extended later.
      out.push({ left: ev, right: candidates[0] });
    }
  }

  return out;
}

