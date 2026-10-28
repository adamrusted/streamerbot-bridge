/**
 * State Streamer.bot keeps that the source apps don't expose: active viewers
 * and stream credits. Both are derived from the event stream.
 */
import type { BridgeEvent, JsonObject } from './types.ts';

type User = { id?: string; login?: string; name?: string; role?: number; subscribed?: boolean };

const userOf = (data: JsonObject): User => (data.user as User | undefined) ?? {};

interface ActiveViewer {
  id: string;
  login: string;
  display: string;
  subscribed: boolean;
  role: string;
  lastSeen: number;
}

const ROLE_NAMES = ['', 'Viewer', 'VIP', 'Moderator', 'Broadcaster'];

export class ActiveViewerTracker {
  #viewers = new Map<string, ActiveViewer>();
  #windowMs: number;

  constructor(windowMinutes: number) {
    this.#windowMs = windowMinutes * 60_000;
  }

  observe(event: BridgeEvent): void {
    if (event.source !== 'Twitch' || event.type !== 'ChatMessage') return;
    const user = userOf(event.data as JsonObject);
    if (!user.id && !user.login) return;
    const id = user.id || user.login!;
    this.#viewers.set(id, {
      id,
      login: user.login ?? '',
      display: user.name ?? user.login ?? '',
      subscribed: user.subscribed ?? false,
      role: ROLE_NAMES[user.role ?? 1] ?? 'Viewer',
      lastSeen: Date.now(),
    });
  }

  list(): JsonObject[] {
    const cutoff = Date.now() - this.#windowMs;
    const viewers: JsonObject[] = [];
    for (const [id, viewer] of this.#viewers) {
      if (viewer.lastSeen < cutoff) {
        this.#viewers.delete(id);
        continue;
      }
      viewers.push({
        id: viewer.id,
        type: 'twitch',
        login: viewer.login,
        display: viewer.display,
        subscribed: viewer.subscribed,
        role: viewer.role,
        groups: [],
        channelPointsUsed: 0,
        previousActive: new Date(viewer.lastSeen).toISOString(),
        exempt: false,
      });
    }
    return viewers;
  }
}

const EVENT_KEYS = [
  'cheers', 'follows', 'gameupdates', 'giftbombs', 'giftsubs', 'goalcontributions',
  'hypetrains', 'pyramids', 'raided', 'resubs', 'rewardredemptions', 'subs',
] as const;

/** Twitch event type → key in the credits `events` object. */
const CREDIT_EVENTS: Record<string, (typeof EVENT_KEYS)[number]> = {
  Cheer: 'cheers',
  Follow: 'follows',
  GiftBomb: 'giftbombs',
  GiftSub: 'giftsubs',
  HypeTrainEnd: 'hypetrains',
  Raid: 'raided',
  ReSub: 'resubs',
  RewardRedemption: 'rewardredemptions',
  Sub: 'subs',
};

function displayName(data: JsonObject): string | undefined {
  const user = userOf(data);
  return (
    user.name ??
    (data.from_broadcaster_user_name as string | undefined) ??
    (data.user_name as string | undefined) ??
    (data.displayName as string | undefined)
  );
}

export class CreditsTracker {
  #events = new Map<string, string[]>();
  #users = new Map<string, string[]>();

  constructor() {
    this.clear();
  }

  clear(): void {
    this.#events = new Map(EVENT_KEYS.map((key) => [key, []]));
    this.#users = new Map(['editors', 'groups', 'moderators', 'subscribers', 'vips', 'users'].map((k) => [k, []]));
  }

  observe(event: BridgeEvent): void {
    if (event.source !== 'Twitch') return;
    const data = event.data as JsonObject;
    const name = displayName(data);
    if (!name) return;

    const key = CREDIT_EVENTS[event.type];
    if (key) this.#push(this.#events, key, name);

    if (event.type === 'ChatMessage') {
      const user = userOf(data);
      this.#push(this.#users, 'users', name);
      if (user.role === 2) this.#push(this.#users, 'vips', name);
      if (user.role === 3) this.#push(this.#users, 'moderators', name);
      if (user.subscribed) this.#push(this.#users, 'subscribers', name);
    }
  }

  #push(map: Map<string, string[]>, key: string, name: string): void {
    const list = map.get(key)!;
    if (!list.includes(name)) list.push(name);
  }

  fillTestData(): void {
    for (const key of EVENT_KEYS) this.#events.set(key, ['TestUser1', 'TestUser2', 'TestUser3']);
    for (const key of this.#users.keys()) this.#users.set(key, ['TestUser1', 'TestUser2']);
  }

  snapshot(): JsonObject {
    return {
      events: Object.fromEntries(this.#events),
      hypeTrain: { conductors: [], contributors: [] },
      users: Object.fromEntries(this.#users),
      top: { allBits: [], monthBits: [], weekBits: [], channelRewards: [] },
      groups: {},
      custom: {},
    };
  }
}
