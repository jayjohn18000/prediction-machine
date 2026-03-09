export function parseSince(s) {
  if (!s || typeof s !== "string") return null;
  const trimmed = s.trim();
  const rel = trimmed.match(/^(\d+)(h|d)$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const d = new Date();
    if (unit === "h") d.setHours(d.getHours() - n);
    else d.setDate(d.getDate() - n);
    return d;
  }
  const t = new Date(trimmed);
  return Number.isNaN(t.getTime()) ? null : t;
}
