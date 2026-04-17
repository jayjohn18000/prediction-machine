/**
 * Haiku batch classifier for markets that fail rule-based classification (Phase E4).
 * Requires ANTHROPIC_API_KEY and @anthropic-ai/sdk.
 */
import Anthropic from "@anthropic-ai/sdk";
import { classifyTemplate } from "./index.mjs";

const BATCH = 50;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";

const ALLOWED_TEMPLATES = `
Crypto (use asset prefix btc-|eth-|sol-|crypto- as appropriate):
btc-daily-range, btc-daily-direction, btc-price-threshold, btc-price-dip, btc-interval, btc-milestone,
btc-generic, crypto-comparative, crypto-corporate,
eth-daily-range, eth-daily-direction, eth-price-threshold, eth-milestone, eth-generic,
sol-daily-range, sol-generic

Economics:
fed-rate-decision, fed-rate-direction, fed-rate-sequence, fed-personnel, fed-dissent, fomc-specific,
cpi-threshold, gdp-threshold, recession-binary, economics-generic

Sports:
sports-moneyline-winner, sports-totals, sports-btts, sports-spread

Politics:
politics-governor, politics-senate, politics-house, politics-election, politics-nominee, politics-fed-chair,
politics-shutdown, politics-supreme-court, politics-nuclear-deal, politics-impeachment, politics-other
(and other politics-* keys matching topic patterns)
`.trim();

const responseCache = new Map();

function normKey(category, title) {
  return `${String(category || "").toLowerCase()}|${String(title || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function parseJsonArray(text) {
  const t = String(text || "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("no_json_array");
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * @param {Array<{ id: number, title: string, category: string }>} markets
 * @returns {Promise<Array<{ id: number, template: string, params: Record<string, unknown> }>>}
 */
export async function classifyBatch(markets) {
  const out = [];
  const needLlm = [];

  for (const m of markets) {
    const key = normKey(m.category, m.title);
    if (responseCache.has(key)) {
      out.push({ id: m.id, ...responseCache.get(key) });
      continue;
    }
    const rule = classifyTemplate({
      title: m.title,
      category: m.category,
      provider_market_ref: m.provider_market_ref,
      provider_id: m.provider_id,
    });
    if (rule) {
      const row = { template: rule.template, params: rule.params || {} };
      responseCache.set(key, row);
      out.push({ id: m.id, ...row });
    } else {
      needLlm.push(m);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (needLlm.length > 0 && !apiKey) {
    for (const m of needLlm) {
      out.push({ id: m.id, template: "unclassified", params: { reason: "no_rule_no_api_key" } });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  if (needLlm.length === 0) {
    return out.sort((a, b) => a.id - b.id);
  }

  const client = new Anthropic({ apiKey });

  for (let i = 0; i < needLlm.length; i += BATCH) {
    const chunk = needLlm.slice(i, i + BATCH);
    const payload = chunk.map((x) => ({
      id: x.id,
      title: x.title,
      category: x.category,
    }));

    const userMsg = `Classify each market into exactly one template from the allowed list.
Return ONLY a JSON array of objects: [{"id":number,"template":"string","params":{}}].
params should include extracted fields: asset, date (YYYY-MM-DD), strike, meeting_date, topic_key as applicable.

Allowed templates:
${ALLOWED_TEMPLATES}

Markets:
${JSON.stringify(payload)}`;

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        "You output valid JSON only: a single array. Pick templates only from the allowed list; never invent new template names.",
      messages: [{ role: "user", content: userMsg }],
    });

    const text = resp.content?.map((b) => (b.type === "text" ? b.text : "")).join("") || "";
    let parsed;
    try {
      parsed = parseJsonArray(text);
    } catch {
      for (const m of chunk) {
        out.push({ id: m.id, template: "unclassified", params: { reason: "llm_parse_error" } });
      }
      continue;
    }

    const byId = new Map(parsed.map((r) => [Number(r.id), r]));
    for (const m of chunk) {
      const r = byId.get(m.id);
      if (!r?.template) {
        out.push({ id: m.id, template: "unclassified", params: { reason: "llm_no_template" } });
        continue;
      }
      const params = typeof r.params === "object" && r.params ? r.params : {};
      const row = { template: String(r.template), params };
      responseCache.set(normKey(m.category, m.title), row);
      out.push({ id: m.id, ...row });
    }
  }

  return out.sort((a, b) => a.id - b.id);
}
