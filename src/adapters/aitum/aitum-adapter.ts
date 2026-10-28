/**
 * Aitum Nexus adapter, built on the Nexus public API
 * (https://app.aitum.help/advanced/public-api/aitum, default http://127.0.0.1:7777/aitum):
 *   - Streamer.bot actions  ⇄ Nexus commands (GET /commands, GET /commands/:id)
 *   - Streamer.bot globals  ⇄ Nexus state variables (GET /state)
 *
 * The public API has no event stream. Events arrive from Aitum's "Send Webhook"
 * action instead:
 *   - POST /ingest/aitum/<platform>/<trigger> with flat trigger variables
 *     (see aitum-triggers.ts and docs/aitum.md);
 *   - POST /ingest/aitum with a full Streamer.bot event
 *     `{"event":{"source","type"},"data":{...}}`; any other body becomes
 *     General.Custom.
 */
import { createLogger } from '../../core/logger.ts';
import type { Bridge } from '../../core/bridge.ts';
import { RequestError, type ActionInfo, type Adapter, type GlobalVariable, type JsonObject } from '../../core/types.ts';
import { parseLenient } from '../shared/webhook-fields.ts';
import { AITUM_TRIGGERS } from './aitum-triggers.ts';

const log = createLogger('aitum');

interface NexusResponse<T> {
  status: string;
  data: T;
}

export class AitumAdapter implements Adapter {
  readonly id = 'aitum';
  #bridge: Bridge;
  #baseUrl: string;
  #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  #reachable = false;

  constructor(bridge: Bridge) {
    this.#bridge = bridge;
    this.#baseUrl = bridge.config.aitum.baseUrl.replace(/\/+$/, '') + '/aitum';
    this.#pollMs = bridge.config.aitum.pollIntervalMs;
  }

  async start(): Promise<void> {
    await this.#poll();
    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
  }

  async #api<T>(path: string): Promise<T> {
    const response = await fetch(this.#baseUrl + path, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Aitum ${path} -> HTTP ${response.status}`);
    const body = (await response.json()) as NexusResponse<T>;
    if (body.status !== 'OK') throw new Error(`Aitum ${path} -> status ${body.status}`);
    return body.data;
  }

  async #poll(): Promise<void> {
    try {
      await this.#api('/commands/');
      if (!this.#reachable) log.info(`connected to Aitum Nexus at ${this.#baseUrl}`);
      this.#reachable = true;
    } catch (err) {
      if (this.#reachable) log.warn('Aitum Nexus unreachable:', (err as Error).message);
      else log.debug('Aitum Nexus unreachable:', (err as Error).message);
      this.#reachable = false;
    }
  }

  async getActions(): Promise<ActionInfo[]> {
    if (!this.#reachable) return [];
    const commands = await this.#api<Record<string, string>>('/commands/');
    return Object.entries(commands).map(([name, id]) => ({
      id,
      name,
      group: 'Aitum',
      enabled: true,
      subaction_count: 0,
      trigger_count: 0,
    }));
  }

  async runAction(actionId: string, args: JsonObject): Promise<void> {
    if (Object.keys(args).length) log.debug('Aitum commands take no arguments; ignoring', args);
    await this.#api(`/commands/${encodeURIComponent(actionId)}`);
  }

  async getGlobals(): Promise<GlobalVariable[]> {
    if (!this.#reachable) return [];
    const state = await this.#api<Array<{ name: string; value: unknown }>>('/state/');
    const now = new Date().toISOString();
    return state.map((v) => ({ name: v.name, value: v.value, lastWrite: now }));
  }

  async handleIngest(subPath: string, body: unknown, rawBody: string): Promise<unknown> {
    if (subPath) {
      const trigger = AITUM_TRIGGERS[subPath.toLowerCase()];
      if (!trigger) throw new RequestError(`Unknown Aitum trigger route: ${subPath} (see docs/aitum.md)`);
      const fields = (body as JsonObject | undefined) ?? parseLenient(rawBody, trigger.keys);
      const events = trigger.map(fields, this.#bridge.twitchChannel());
      // Aitum gives display names only, so sub status has to be looked up.
      for (const e of events) await this.#bridge.emit(this.id, e.source, e.type, e.data, { unknownSubscription: true });
      return { status: 'ok', emitted: events.map((e) => `${e.source}.${e.type}`) };
    }

    if (body === undefined) throw new RequestError('Body is not valid JSON');
    const payload = (body ?? {}) as JsonObject;
    const event = (payload.event ?? payload) as JsonObject;
    if (typeof event.source === 'string' && typeof event.type === 'string') {
      await this.#bridge.emit(this.id, event.source, event.type, payload.data ?? {});
    } else {
      await this.#bridge.emit(this.id, 'General', 'Custom', payload);
    }
    return { status: 'ok' };
  }
}
