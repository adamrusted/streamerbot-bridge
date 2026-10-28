/**
 * Pronoun lookups via the alejo.io API, the same service Streamer.bot uses for
 * its GetUserPronouns request.
 */
import { createLogger } from './logger.ts';
import type { JsonObject } from './types.ts';

const log = createLogger('pronouns');
const API = 'https://api.pronouns.alejo.io/v1';
const CACHE_MS = 60 * 60_000;

interface PronounDef {
  name: string;
  subject: string;
  object: string;
  singular: boolean;
}

async function fetchJson(url: string): Promise<unknown | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

export class PronounService {
  #enabled: boolean;
  #definitions: Record<string, PronounDef> | undefined;
  #cache = new Map<string, { at: number; value: JsonObject }>();

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  /**
   * Always resolves to a Streamer.bot-shaped `pronoun` object. Widgets read
   * `pronoun.userFound` without a null check, so failures become "not found".
   */
  async lookup(userLogin: string): Promise<JsonObject> {
    const login = userLogin.toLowerCase();
    const cached = this.#cache.get(login);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

    let value = notFound(login);
    if (this.#enabled && login) {
      try {
        value = await this.#fetch(login);
      } catch (err) {
        log.debug(`lookup failed for ${login}:`, (err as Error).message);
      }
    }
    this.#cache.set(login, { at: Date.now(), value });
    return value;
  }

  async #fetch(login: string): Promise<JsonObject> {
    this.#definitions ??= (await fetchJson(`${API}/pronouns`)) as Record<string, PronounDef>;
    const user = (await fetchJson(`${API}/users/${encodeURIComponent(login)}`)) as
      | { channel_id: string; pronoun_id: string; alt_pronoun_id: string | null }
      | undefined;
    if (!user) return notFound(login);

    const main = this.#definitions[user.pronoun_id];
    const alt = user.alt_pronoun_id ? this.#definitions[user.alt_pronoun_id] : undefined;
    const subject = main?.subject ?? '';
    const object = alt ? alt.subject : (main?.object ?? '');
    const pronouns = main ? (main.singular ? subject : `${subject}/${object}`) : '';
    return {
      userId: user.channel_id,
      userLogin: login,
      pronounId: user.pronoun_id,
      altPronounId: user.alt_pronoun_id ?? '',
      pronounSubject: subject,
      pronounObject: object,
      altPronounSubject: alt?.subject ?? '',
      altPronounObject: alt?.object ?? '',
      pronouns,
      pronounsPlain: pronouns,
      pronounLastCached: new Date().toISOString(),
      userFound: true,
    };
  }
}

function notFound(login: string): JsonObject {
  return {
    userLogin: login,
    pronounSubject: '',
    pronounObject: '',
    pronouns: '',
    pronounsPlain: '',
    pronounLastCached: new Date().toISOString(),
    userFound: false,
  };
}
