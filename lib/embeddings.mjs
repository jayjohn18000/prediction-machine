import OpenAI from "openai";

/** @type {OpenAI | null} */
let client = null;

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for embeddings");
  }
  if (!client) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

/** @type {Map<string, number[]>} */
const cache = new Map();

const MODEL = "text-embedding-3-small"; // 1536 dims, $0.02 / 1M tokens

/**
 * Convert an embedding vector to pgvector textual representation.
 * @param {number[]} vec
 * @returns {string}
 */
export function toPgVectorLiteral(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return "[]";
  return `[${vec.join(",")}]`;
}

/**
 * Embed a single text string with in-process caching.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const key = String(text || "").trim();
  if (!key) return [];
  if (cache.has(key)) return cache.get(key);

  const c = getClient();
  const res = await c.embeddings.create({
    model: MODEL,
    input: key,
  });
  const vec = res.data[0]?.embedding || [];
  cache.set(key, vec);
  return vec;
}

/**
 * Embed a batch of texts. Empty/blank strings return empty vectors.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts) {
  const inputs = (texts || []).map((t) => String(t || "").trim());
  if (inputs.length === 0) return [];

  const c = getClient();
  const res = await c.embeddings.create({
    model: MODEL,
    input: inputs,
  });
  return res.data.map((d) => d.embedding || []);
}

