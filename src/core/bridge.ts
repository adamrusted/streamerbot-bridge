/**
 * The hub between adapters (Firebot, Aitum, ...) and the Streamer.bot-facing
 * servers. Request handlers only talk to this class, never to adapters.
 */
import type { BridgeConfig } from '../config.ts';
import { Enricher, stripImagelessBadges, type EnrichHints } from '../enrich/enricher.ts';
import type { TwitchUserInfo } from '../enrich/twitch-directory.ts';
import { EventBus } from './event-bus.ts';
import { createLogger } from './logger.ts';
import { PronounService } from './pronouns.ts';
import { ActiveViewerTracker, CreditsTracker } from './trackers.ts';
import {
  RequestError,
  type ActionInfo,
  type Adapter,
  type BroadcasterInfo,
  type BroadcasterPlatform,
  type GlobalVariable,
  type JsonObject,
  type SendMessageOptions,
} from './types.ts';

const log = createLogger('bridge');

export class Bridge {
  readonly config: BridgeConfig;
  readonly bus = new EventBus();
  readonly viewers: ActiveViewerTracker;
  readonly credits = new CreditsTracker();
  readonly pronouns: PronounService;
  readonly adapters = new Map<string, Adapter>();
  readonly enricher: Enricher;
  /** action id → owning adapter, refreshed on every getActions() */
  #actionOwners = new Map<string, { adapter: Adapter; action: ActionInfo }>();
  /** Publishes happen in arrival order even though enrichment runs concurrently. */
  #emitQueue: Promise<void> = Promise.resolve();
  /** Last ivr.fi lookup of the configured/reported Twitch broadcaster. */
  #broadcasterInfo: TwitchUserInfo | undefined;
  #refreshingBroadcaster = false;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.viewers = new ActiveViewerTracker(config.activeViewerWindowMinutes);
    this.pronouns = new PronounService(config.pronouns.enabled);
    this.enricher = new Enricher(config.enrichment, () => this.twitchChannel());
    this.bus.subscribe((event) => {
      this.viewers.observe(event);
      this.credits.observe(event);
    });
  }

  /**
   * The way adapters publish events: fills in missing Twitch detail (bounded
   * by enrichment.timeoutMs), then publishes in the order events arrived.
   * Resolves once the event has been delivered.
   */
  emit(origin: string, source: string, type: string, data: unknown, hints: EnrichHints = {}): Promise<void> {
    const event = { source, type, data };
    const enriched = Promise.race([
      this.enricher.enrich(event, hints).catch((err) => log.debug('enrichment failed:', (err as Error).message)),
      new Promise((resolve) => setTimeout(resolve, this.config.enrichment.timeoutMs).unref()),
    ]);
    const published = this.#emitQueue
      .then(() => enriched)
      .then(() => {
        stripImagelessBadges(event);
        this.bus.publish(origin, source, type, event.data);
      });
    this.#emitQueue = published.catch(() => {});
    return published;
  }

  /** Looks up the broadcaster's Twitch id and partner status, used by GetBroadcaster. */
  async #refreshBroadcaster(): Promise<void> {
    const { enrichment } = this.config;
    if (!enrichment.enabled || !enrichment.users || this.#refreshingBroadcaster) return;
    this.#refreshingBroadcaster = true;
    try {
      const login = this.twitchChannel().login;
      if (login) this.#broadcasterInfo = (await this.enricher.directory.user(login).catch(() => undefined)) ?? this.#broadcasterInfo;
    } finally {
      this.#refreshingBroadcaster = false;
    }
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.start();
        log.info(`adapter "${adapter.id}" started`);
      } catch (err) {
        log.error(`adapter "${adapter.id}" failed to start:`, err);
      }
    }
    // Background: channel-wide lookups so the first events don't wait on them.
    void this.#refreshBroadcaster().then(() => this.enricher.warm());
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.stop()));
  }

  async getActions(): Promise<ActionInfo[]> {
    const owners = new Map<string, { adapter: Adapter; action: ActionInfo }>();
    for (const adapter of this.adapters.values()) {
      if (!adapter.getActions) continue;
      try {
        for (const action of await adapter.getActions()) owners.set(action.id, { adapter, action });
      } catch (err) {
        log.warn(`getActions failed for "${adapter.id}":`, (err as Error).message);
      }
    }
    this.#actionOwners = owners;
    return [...owners.values()].map((o) => o.action);
  }

  /** Resolves by id first, then by case-insensitive name, like Streamer.bot. */
  async doAction(ref: { id?: string; name?: string }, args: JsonObject): Promise<void> {
    let owner = this.#findAction(ref);
    if (!owner) {
      await this.getActions();
      owner = this.#findAction(ref);
    }
    if (!owner) throw new RequestError(`Action not found: ${ref.id ?? ref.name}`);
    if (!owner.adapter.runAction) throw new RequestError(`Adapter "${owner.adapter.id}" cannot run actions`);
    log.info(`DoAction "${owner.action.name}" via ${owner.adapter.id}`);
    await owner.adapter.runAction(owner.action.id, args);
  }

  #findAction(ref: { id?: string; name?: string }) {
    if (ref.id && this.#actionOwners.has(ref.id)) return this.#actionOwners.get(ref.id);
    if (!ref.name) return undefined;
    const name = ref.name.toLowerCase();
    for (const owner of this.#actionOwners.values()) {
      if (owner.action.name.toLowerCase() === name) return owner;
    }
    return undefined;
  }

  async sendMessage(platform: string, message: string, options: SendMessageOptions): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (adapter.sendMessage && (await adapter.sendMessage(platform, message, options))) return;
    }
    throw new RequestError(`No connected adapter can send messages to "${platform}"`);
  }

  async getGlobals(): Promise<GlobalVariable[]> {
    const all: GlobalVariable[] = [];
    for (const adapter of this.adapters.values()) {
      if (!adapter.getGlobals) continue;
      try {
        all.push(...(await adapter.getGlobals()));
      } catch (err) {
        log.warn(`getGlobals failed for "${adapter.id}":`, (err as Error).message);
      }
    }
    return all;
  }

  /** Asks adapters that support direct lookup; used when a name isn't in getGlobals(). */
  async getGlobal(name: string): Promise<GlobalVariable | undefined> {
    for (const adapter of this.adapters.values()) {
      if (!adapter.getGlobal) continue;
      try {
        const found = await adapter.getGlobal(name);
        if (found) return found;
      } catch (err) {
        log.debug(`getGlobal failed for "${adapter.id}":`, (err as Error).message);
      }
    }
    return undefined;
  }

  /** Merges adapter-reported broadcasters with manual config (config wins). */
  getBroadcasters(): Map<BroadcasterPlatform, BroadcasterInfo> {
    const result = new Map<BroadcasterPlatform, BroadcasterInfo>();
    for (const adapter of this.adapters.values()) {
      for (const info of adapter.getBroadcasters?.() ?? []) {
        const existing = result.get(info.platform);
        result.set(info.platform, {
          platform: info.platform,
          connected: info.connected || (existing?.connected ?? false),
          data: { ...existing?.data, ...info.data },
        });
      }
    }
    const twitch = this.config.broadcaster.twitch;
    if (twitch?.login) {
      const existing = result.get('twitch');
      result.set('twitch', {
        platform: 'twitch',
        connected: existing?.connected ?? false,
        data: {
          ...existing?.data,
          broadcastUser: twitch.displayName || twitch.login,
          broadcastUserName: twitch.login,
          broadcastUserId: twitch.userId || existing?.data.broadcastUserId || '',
          broadcastIsAffiliate: twitch.isAffiliate ?? existing?.data.broadcastIsAffiliate ?? false,
          broadcastIsPartner: twitch.isPartner ?? existing?.data.broadcastIsPartner ?? false,
        },
      });
    }
    const looked = this.#broadcasterInfo;
    const current = result.get('twitch');
    if (looked && current && String(current.data.broadcastUserName ?? '').toLowerCase() === looked.login) {
      // Fill gaps only; values from the source app or config win.
      current.data.broadcastUserId ||= looked.id;
      current.data.broadcastIsAffiliate ||= looked.isAffiliate;
      current.data.broadcastIsPartner ||= looked.isPartner;
      if (current.data.broadcastUser === looked.login) current.data.broadcastUser = looked.displayName;
    } else if (current && !looked) {
      void this.#refreshBroadcaster();
    }

    const kick = this.config.broadcaster.kick;
    if (kick?.login) {
      const login = kick.login.toLowerCase();
      // No published Streamer.bot type for Kick; Nutty reads `broadcasterLogin`.
      result.set('kick', {
        platform: 'kick',
        connected: false,
        data: {
          broadcasterLogin: login,
          broadcasterUserName: kick.displayName || kick.login,
          broadcasterUserId: kick.userId || '',
          broadcastUser: kick.displayName || kick.login,
          broadcastUserName: login,
          broadcastUserId: kick.userId || '',
        },
      });
    }
    return result;
  }

  /** Twitch channel identity used to fill e.g. Raid.to_broadcaster_* fields. */
  twitchChannel(): { id: string; login: string; name: string } {
    const data = this.getBroadcasters().get('twitch')?.data ?? {};
    return {
      id: String(data.broadcastUserId ?? ''),
      login: String(data.broadcastUserName ?? ''),
      name: String(data.broadcastUser ?? data.broadcastUserName ?? ''),
    };
  }
}
