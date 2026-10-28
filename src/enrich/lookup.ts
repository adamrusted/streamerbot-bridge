/** Cached, de-duplicated JSON lookups against public APIs. */

export async function getJson(url: string, timeoutMs = 4000): Promise<unknown | undefined> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'sb-bridge (+https://github.com/)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

/**
 * Caches the promise per key, so concurrent callers share one request.
 * Failures are cached briefly to avoid hammering a struggling service.
 */
export class TtlCache<T> {
  #entries = new Map<string, { expires: number; value: Promise<T> }>();
  #ttlMs: number;
  #failureTtlMs: number;
  #maxEntries: number;

  constructor(ttlMs: number, options: { failureTtlMs?: number; maxEntries?: number } = {}) {
    this.#ttlMs = ttlMs;
    this.#failureTtlMs = options.failureTtlMs ?? 60_000;
    this.#maxEntries = options.maxEntries ?? 5000;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.#entries.get(key);
    if (hit && hit.expires > now) return hit.value;

    const value = load();
    const entry = { expires: now + this.#ttlMs, value };
    value.catch(() => {
      entry.expires = Date.now() + this.#failureTtlMs;
    });
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
    return value;
  }

  /** The settled value if already loaded, without triggering a load. */
  peek(key: string): Promise<T> | undefined {
    const hit = this.#entries.get(key);
    return hit && hit.expires > Date.now() ? hit.value : undefined;
  }
}
