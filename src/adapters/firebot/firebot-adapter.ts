/**
 * Firebot adapter.
 *
 * Inbound: the Firebot startup script (integrations/firebot/sb-bridge.js) POSTs
 * every Firebot event to /ingest/firebot/event; the mapper turns them into
 * Streamer.bot events.
 *
 * Outbound: Firebot's local HTTP API (default http://127.0.0.1:7472/api/v1).
 *   - Streamer.bot actions  ⇄ Firebot preset effect lists
 *   - Streamer.bot globals  ⇄ Firebot custom variables
 *   - SendMessage          → a firebot:chat effect
 */
import { createLogger } from '../../core/logger.ts';
import type { Bridge } from '../../core/bridge.ts';
import {
  RequestError,
  type ActionInfo,
  type Adapter,
  type BroadcasterInfo,
  type GlobalVariable,
  type JsonObject,
  type SendMessageOptions,
} from '../../core/types.ts';
import { FirebotEventMapper, type FirebotEvent } from './firebot-mapper.ts';

const log = createLogger('firebot');

interface StreamerAccount {
  username?: string;
  displayName?: string;
  userId?: string;
  broadcasterType?: string;
}

export class FirebotAdapter implements Adapter {
  readonly id = 'firebot';
  #bridge: Bridge;
  #baseUrl: string;
  #pollMs: number;
  #timer: NodeJS.Timeout | undefined;
  #mapper: FirebotEventMapper;
  #apiReachable = false;
  #chatConnected = false;
  #streamer: StreamerAccount | undefined;

  constructor(bridge: Bridge) {
    this.#bridge = bridge;
    this.#baseUrl = bridge.config.firebot.baseUrl.replace(/\/+$/, '') + '/api/v1';
    this.#pollMs = bridge.config.firebot.pollIntervalMs;
    this.#mapper = new FirebotEventMapper({
      channel: () => bridge.twitchChannel(),
      emitUnmappedAsCustom: bridge.config.firebot.emitUnmappedAsCustom,
    });
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
    if (!response.ok) throw new Error(`Firebot ${path} -> HTTP ${response.status}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async #poll(): Promise<void> {
    try {
      const status = await this.#api<{ connections?: { chat?: boolean } }>('/status');
      if (!this.#apiReachable) log.info(`connected to Firebot API at ${this.#baseUrl}`);
      this.#apiReachable = true;
      this.#chatConnected = Boolean(status?.connections?.chat);
    } catch (err) {
      if (this.#apiReachable) log.warn('Firebot API unreachable:', (err as Error).message);
      else log.debug('Firebot API unreachable:', (err as Error).message);
      this.#apiReachable = false;
      this.#chatConnected = false;
    }
  }

  async handleIngest(subPath: string, body: unknown): Promise<unknown> {
    if (body === undefined) throw new RequestError('Body is not valid JSON');
    switch (subPath) {
      case 'event': {
        const event = body as FirebotEvent;
        if (!event?.sourceId || !event?.eventId) throw new Error('Expected {sourceId, eventId, meta}');
        log.debug(`event ${event.sourceId}:${event.eventId}`, JSON.stringify(event.meta ?? {}));
        const mapped = this.#mapper.map(event);
        for (const out of mapped) await this.#bridge.emit(this.id, out.source, out.type, out.data);
        return { status: 'ok', emitted: mapped.map((e) => `${e.source}.${e.type}`) };
      }
      case 'hello': {
        const hello = body as { firebotVersion?: string; streamer?: StreamerAccount };
        this.#streamer = hello.streamer;
        log.info(`Firebot script connected (Firebot ${hello.firebotVersion ?? '?'}, streamer ${hello.streamer?.username ?? '?'})`);
        return { status: 'ok' };
      }
      case 'custom':
        await this.#bridge.emit(this.id, 'General', 'Custom', body);
        return { status: 'ok' };
    }
    throw new Error(`Unknown Firebot ingest route: ${subPath}`);
  }

  getBroadcasters(): BroadcasterInfo[] {
    if (!this.#streamer?.username) return [];
    const s = this.#streamer;
    return [
      {
        platform: 'twitch',
        connected: this.#chatConnected || !this.#apiReachable, // script is live even if the API poll lags
        data: {
          broadcastUser: s.displayName ?? s.username,
          broadcastUserName: s.username!.toLowerCase(),
          broadcastUserId: s.userId ?? '',
          broadcastIsAffiliate: s.broadcasterType === 'affiliate',
          broadcastIsPartner: s.broadcasterType === 'partner',
        },
      },
    ];
  }

  async getActions(): Promise<ActionInfo[]> {
    if (!this.#apiReachable) return [];
    const raw = await this.#api<unknown>('/effects/preset');
    // Firebot returns [{ id, name, args: string[] }]
    const lists = (Array.isArray(raw) ? raw : Object.values(raw ?? {})) as Array<{ id: string; name: string }>;
    return lists.map((p) => ({
      id: p.id,
      name: p.name,
      group: 'Firebot',
      enabled: true,
      subaction_count: 0,
      trigger_count: 0,
    }));
  }

  async runAction(actionId: string, args: JsonObject): Promise<void> {
    await this.#api(`/effects/preset/${encodeURIComponent(actionId)}`, { method: 'POST', body: { args } });
  }

  async sendMessage(platform: string, message: string, options: SendMessageOptions): Promise<boolean> {
    if (platform !== 'twitch' || !this.#apiReachable) return false;
    await this.#api('/effects', {
      method: 'POST',
      body: { effects: { list: [{ type: 'firebot:chat', message, chatter: options.bot ? 'Bot' : 'Streamer' }] } },
    });
    return true;
  }

  async getGlobals(): Promise<GlobalVariable[]> {
    if (!this.#apiReachable) return [];
    const vars = await this.#api<Record<string, { v: unknown; t?: number; meta?: { persist?: boolean } }>>('/custom-variables');
    const now = new Date().toISOString();
    return Object.entries(vars ?? {}).map(([name, entry]) => ({
      name,
      value: entry?.v,
      lastWrite: now,
      persisted: Boolean(entry?.meta?.persist),
    }));
  }
}
