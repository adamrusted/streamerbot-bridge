/**
 * Mix It Up adapter.
 *
 * Inbound: Mix It Up "Web Request" actions POST special identifiers to
 * /ingest/mixitup/<event> (see mixitup-events.ts, docs/mixitup.md).
 *
 * Outbound: the Developer API (Services → Developer API, http://localhost:8911/api/v2):
 *   - Streamer.bot actions  ⇄ Mix It Up commands (DoAction args become special identifiers)
 *   - Streamer.bot globals  ⇄ Mix It Up counters
 *   - SendMessage          → POST /chat/message
 */
import type { Bridge } from '../../core/bridge.ts';
import { createLogger } from '../../core/logger.ts';
import {
  RequestError,
  type ActionInfo,
  type Adapter,
  type GlobalVariable,
  type JsonObject,
  type SendMessageOptions,
} from '../../core/types.ts';
import { parseLenient } from '../shared/webhook-fields.ts';
import { MIXITUP_EVENTS, type MixItUpContext } from './mixitup-events.ts';

const log = createLogger('mixitup');
const PAGE_SIZE = 200;
const RECENT_MESSAGES = 500;

interface MiuCommand {
  ID: string;
  Name: string;
  Type: string;
  IsEnabled: boolean;
  GroupName?: string;
}

export class MixItUpAdapter implements Adapter {
  readonly id = 'mixitup';
  #bridge: Bridge;
  #baseUrl: string;
  #pollMs: number;
  #ignoreRequirements: boolean;
  #timer: NodeJS.Timeout | undefined;
  #reachable = false;
  /** `${login}\n${text}` → generated message id, oldest first. */
  #recent = new Map<string, string>();

  constructor(bridge: Bridge) {
    const config = bridge.config.mixitup;
    this.#bridge = bridge;
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '') + '/api/v2';
    this.#pollMs = config.pollIntervalMs;
    this.#ignoreRequirements = config.ignoreRequirements;
  }

  async start(): Promise<void> {
    await this.#poll();
    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
  }

  async #api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const response = await fetch(this.#baseUrl + path, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Mix It Up ${path} -> HTTP ${response.status}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async #poll(): Promise<void> {
    try {
      const version = await this.#api<string>('/status/version');
      if (!this.#reachable) log.info(`connected to Mix It Up ${version} at ${this.#baseUrl}`);
      this.#reachable = true;
    } catch (err) {
      if (this.#reachable) log.warn('Mix It Up unreachable:', (err as Error).message);
      else log.debug('Mix It Up unreachable:', (err as Error).message);
      this.#reachable = false;
    }
  }

  #context(): MixItUpContext {
    return {
      channel: this.#bridge.twitchChannel(),
      rememberMessage: (login, text, messageId) => {
        this.#recent.set(`${login}\n${text}`, messageId);
        if (this.#recent.size > RECENT_MESSAGES) this.#recent.delete(this.#recent.keys().next().value!);
      },
      recallMessage: (login, text) => this.#recent.get(`${login}\n${text}`),
    };
  }

  async handleIngest(subPath: string, body: unknown, rawBody: string): Promise<unknown> {
    const event = MIXITUP_EVENTS[subPath.toLowerCase()];
    if (!event) throw new RequestError(`Unknown Mix It Up event route: ${subPath || '(none)'} (see docs/mixitup.md)`);
    const fields = (body as JsonObject | undefined) ?? parseLenient(rawBody, event.keys);
    const events = event.map(fields, this.#context());
    for (const e of events) await this.#bridge.emit(this.id, e.source, e.type, e.data);
    return { status: 'ok', emitted: events.map((e) => `${e.source}.${e.type}`) };
  }

  async getActions(): Promise<ActionInfo[]> {
    if (!this.#reachable) return [];
    const commands: MiuCommand[] = [];
    for (let skip = 0; ; skip += PAGE_SIZE) {
      const page = await this.#api<{ TotalCount?: number; Commands?: MiuCommand[] }>(`/commands?skip=${skip}&pageSize=${PAGE_SIZE}`);
      commands.push(...(page?.Commands ?? []));
      if (!page?.Commands?.length || commands.length >= (page.TotalCount ?? 0)) break;
    }
    return commands.map((c) => ({
      id: c.ID,
      name: c.Name,
      group: c.GroupName || `Mix It Up ${c.Type}`,
      enabled: c.IsEnabled,
      subaction_count: 0,
      trigger_count: 0,
    }));
  }

  /** Args become special identifiers ($argname); `arguments` (or `rawInput`) becomes the command's text arguments. */
  async runAction(actionId: string, args: JsonObject): Promise<void> {
    const identifiers = Object.fromEntries(
      Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    );
    await this.#api(`/commands/${encodeURIComponent(actionId)}`, {
      method: 'POST',
      body: {
        Platform: String(args.platform ?? 'Twitch'),
        Arguments: String(args.arguments ?? args.rawInput ?? ''),
        SpecialIdentifiers: identifiers,
        IgnoreRequirements: this.#ignoreRequirements,
      },
    });
  }

  async sendMessage(platform: string, message: string, options: SendMessageOptions): Promise<boolean> {
    const platforms: Record<string, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
    if (!this.#reachable || !platforms[platform]) return false;
    await this.#api('/chat/message', {
      method: 'POST',
      body: { Message: message, Platform: platforms[platform], SendAsStreamer: !options.bot },
    });
    return true;
  }

  async getGlobals(): Promise<GlobalVariable[]> {
    if (!this.#reachable) return [];
    const result = await this.#api<{ Counters?: Array<{ Name: string; Amount: number }> }>('/counters');
    const now = new Date().toISOString();
    return (result?.Counters ?? []).map((c) => ({ name: c.Name, value: c.Amount, lastWrite: now, persisted: true }));
  }
}
