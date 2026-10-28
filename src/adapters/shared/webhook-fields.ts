/**
 * Helpers for adapters fed by an app's own "web request" action (Aitum, Mix It
 * Up, SAMMI): the app substitutes its variables into a body as text, so values
 * arrive as loosely-typed strings and the JSON itself may be broken.
 */
export type Fields = Record<string, unknown>;

export const str = (v: unknown, fallback = ''): string => (v === undefined || v === null ? fallback : String(v));

export const num = (v: unknown, fallback = 0): number => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return v === undefined || v === '' || !Number.isFinite(n) ? fallback : n;
};

export const bool = (v: unknown): boolean => v === true || v === 1 || /^(true|yes|1)$/i.test(String(v ?? '').trim());

/**
 * Parses a body whose values were substituted as raw text, so a chat message
 * containing `"` or `\` produces invalid JSON. When strict parsing fails, each
 * known key's value is taken by position instead.
 */
export function parseLenient(raw: string, keys: string[]): Fields {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through
  }
  const found: Array<{ key: string; start: number; valueStart: number }> = [];
  for (const key of keys) {
    const match = new RegExp(`"${key}"\\s*:\\s*`).exec(raw);
    if (match) found.push({ key, start: match.index, valueStart: match.index + match[0].length });
  }
  found.sort((a, b) => a.start - b.start);
  const out: Fields = {};
  found.forEach((entry, i) => {
    const end = i + 1 < found.length ? found[i + 1].start : raw.lastIndexOf('}');
    let value = raw.slice(entry.valueStart, end > entry.valueStart ? end : undefined).trim().replace(/,$/, '').trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    out[entry.key] = value;
  });
  return out;
}

/** Lower-cases keys and strips separators, so "User Name", "user_name" and "userName" all read as "username". */
export function normalizeKeys(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) out[key.toLowerCase().replace(/[^a-z0-9]/g, '')] = value;
  return out;
}
