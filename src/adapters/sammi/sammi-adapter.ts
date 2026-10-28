/**
 * SAMMI adapter.
 *
 * Inbound: a SAMMI button POSTs stringified trigger objects to
 * /ingest/sammi/event/<trigger type> (see sammi-triggers.ts, docs/sammi.md).
 *
 * Outbound: SAMMI's local API (Settings → Open Local API Server, http://localhost:9450):
 *   - Streamer.bot actions → configured webhook triggers (POST /webhook) or buttons (triggerButton).
 *     SAMMI has no endpoint to list buttons, so actions come from config.
 *   - Streamer.bot globals → getVariable, for configured names (GetGlobal reads any name).
 */
import type { Bridge } from '../../core/bridge.ts';
import { createLogger } from '../../core/logger.ts';
import { RequestError, type ActionInfo, type Adapter, type GlobalVariable, type JsonObject } from '../../core/types.ts';
import { normalizeKeys } from '../shared/webhook-fields.ts';
import { mapSammiTrigger, type SammiContext } from './sammi-triggers.ts';

const log = createLogger('sammi');

interface ConfiguredAction {
  info: ActionInfo;
  buttonId?: string;
  webhook?: string;
}

export class SammiAdapter implements Adapter {
  readonly id = 'sammi';
  #bridge: Bridge;
  #baseUrl: string;
  #password: string;
  #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  #reachable = false;
  #actions = new Map<string, ConfiguredAction>();
  #context: SammiContext;

  constructor(bridge: Bridge) {
    const config = bridge.config.sammi;
    this.#bridge = bridge;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.#password = config.password;
    this.#pollMs = config.pollIntervalMs;
    this.#context = { channel: bridge.twitchChannel(), hypeTrainLevel: 0 };
    for (const entry of config.actions) {
      const action = typeof entry === 'string' ? { name: entry } : entry;
      const id = `sammi:${action.buttonId ?? action.webhook ?? action.name}`;
      this.#actions.set(id, {
        info: { id, name: action.name, group: 'SAMMI', enabled: true, subaction_count: 0, trigger_count: 0 },
        buttonId: action.buttonId,
        webhook: action.buttonId ? undefined : (action.webhook ?? action.name),
      });
    }
  }

  async start(): Promise<void> {
    await this.#poll();
    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
  }

  async #call<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.#password) headers.authorization = this.#password;
    const response = await fetch(this.#baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`SAMMI ${path} -> HTTP ${response.status} ${json.Description ?? json.Error ?? ''}`.trim());
    return json as T;
  }

  #getVariable(name: string) {
    return this.#call<{ data: unknown }>(`/api?request=getVariable&name=${encodeURIComponent(name)}`);
  }

  async #poll(): Promise<void> {
    try {
      // "Architecture" is a built-in SAMMI global, so this doubles as a health check.
      await this.#getVariable('Architecture');
      if (!this.#reachable) log.info(`connected to SAMMI at ${this.#baseUrl}`);
      this.#reachable = true;
    } catch (err) {
      if (this.#reachable) log.warn('SAMMI unreachable:', (err as Error).message);
      else log.debug('SAMMI unreachable:', (err as Error).message);
      this.#reachable = false;
    }
  }

  async handleIngest(subPath: string, body: unknown): Promise<unknown> {
    const [route, typeSegment] = subPath.split('/');
    if (route !== 'event') throw new RequestError(`Unknown SAMMI route: ${subPath || '(none)'} (see docs/sammi.md)`);
    if (body === undefined || typeof body !== 'object' || body === null) {
      throw new RequestError('Body must be the stringified trigger object (see docs/sammi.md)');
    }
    const fields = normalizeKeys(body as JsonObject);
    const triggerType = Number(typeSegment ?? fields.triggertype);
    log.debug(`trigger ${triggerType}`, JSON.stringify(body));
    if (!Number.isInteger(triggerType)) throw new RequestError('Missing trigger type: POST to /ingest/sammi/event/<trigger type>');

    this.#context.channel = this.#bridge.twitchChannel();
    const events = mapSammiTrigger(triggerType, fields, this.#context) ?? [
      { source: 'General', type: 'Custom', data: { bridge: 'sammi', triggerType, ...(body as JsonObject) } },
    ];
    for (const e of events) await this.#bridge.emit(this.id, e.source, e.type, e.data);
    return { status: 'ok', emitted: events.map((e) => `${e.source}.${e.type}`) };
  }

  async getActions(): Promise<ActionInfo[]> {
    return [...this.#actions.values()].map((a) => a.info);
  }

  async runAction(actionId: string, args: JsonObject): Promise<void> {
    const action = this.#actions.get(actionId);
    if (!action) throw new RequestError(`Unknown SAMMI action ${actionId}`);
    if (action.buttonId) {
      await this.#call('/api', { request: 'triggerButton', buttonID: action.buttonId });
    } else {
      await this.#call('/webhook', { ...args, trigger: action.webhook });
    }
  }

  async getGlobals(): Promise<GlobalVariable[]> {
    if (!this.#reachable) return [];
    const found = await Promise.all(this.#bridge.config.sammi.globals.map((name) => this.getGlobal(name)));
    return found.filter((g): g is GlobalVariable => Boolean(g));
  }

  async getGlobal(name: string): Promise<GlobalVariable | undefined> {
    if (!this.#reachable) return undefined;
    try {
      const { data } = await this.#getVariable(name);
      return data === undefined ? undefined : { name, value: data, lastWrite: new Date().toISOString(), persisted: true };
    } catch {
      return undefined;
    }
  }
}
