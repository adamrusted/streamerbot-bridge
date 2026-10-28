/**
 * Fills gaps in Twitch event payloads from public lookups, so a widget sees
 * the same detail whichever app the event came from:
 *  - real user ids (replacing `aitum-…` style placeholders), name colour, avatar
 *  - mod/VIP role from the channel's lists; sub status when the source can't know it
 *  - badge images (resolving named badges, or synthesizing role/sub badges)
 *  - emote images for codes left in text parts (Twitch, 7TV, BTTV, FFZ)
 *  - cheermote images
 * Every step only fills what's missing or upgrades what's known to be a
 * default; real data from the source app is never replaced.
 */
import type { JsonObject, SbEventOut } from '../core/types.ts';
import { legacyEmotes, ROLE, type SbBadge, type SbMessagePart } from '../sb/payloads/twitch.ts';
import { TwitchDirectory, type BadgeSets, type EmoteInfo } from './twitch-directory.ts';

export interface EnrichmentConfig {
  enabled: boolean;
  timeoutMs: number;
  users: boolean;
  rolesAndSubs: boolean;
  badges: boolean;
  emotes: boolean;
  ivrBaseUrl: string;
  sevenTvBaseUrl: string;
  bttvBaseUrl: string;
}

export interface EnrichHints {
  /** The source can't tell whether users are subscribed (Aitum), so look it up. */
  unknownSubscription?: boolean;
}

export interface ChannelRef {
  login: string;
  id: string;
}

type User = JsonObject & {
  id: string;
  login: string;
  name: string;
  color?: string;
  role?: number;
  subscribed?: boolean;
  subscriptionTier?: string;
  monthsSubscribed?: number;
  badges?: SbBadge[];
  profileImageUrl?: string;
};

const PLACEHOLDER_ID = /^(aitum|mixitup|sammi)-/;
const CHEER_TIERS = [100000, 10000, 5000, 1000, 100, 1];
/** Legacy (0.2.x) mirrors of the primary user's fields, at the top level or under `message`. */
const MIRRORED = ['color', 'role', 'subscriber', 'subscriptionTier', 'monthsSubscribed', 'badges'] as const;

function replaceDeep(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) {
    value.forEach((v, i) => (value[i] = replaceDeep(v, from, to)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) (value as JsonObject)[k] = replaceDeep(v, from, to);
  }
  return value;
}

function isTwitchUser(value: unknown): value is User {
  return Boolean(value) && typeof value === 'object' && (value as JsonObject).type === 'twitch' && typeof (value as JsonObject).login === 'string';
}

/** Badges render as `<img src>` in widgets, so any without an image are removed. Always runs. */
export function stripImagelessBadges(event: SbEventOut): void {
  if (event.source !== 'Twitch' || !event.data || typeof event.data !== 'object') return;
  const data = event.data as JsonObject;
  const clean = (badges: unknown) => (Array.isArray(badges) ? badges.filter((b) => b?.imageUrl) : badges);
  for (const user of usersOf(data)) user.badges = clean(user.badges) as SbBadge[];
  if (Array.isArray(data.badges)) data.badges = clean(data.badges);
  const legacy = data.message as JsonObject | undefined;
  if (legacy && typeof legacy === 'object' && Array.isArray(legacy.badges)) legacy.badges = clean(legacy.badges);
}

function usersOf(data: JsonObject): User[] {
  const candidates = [data.user, data.targetUser, data.recipient, ...(Array.isArray(data.recipients) ? data.recipients : [])];
  return [...new Set(candidates.filter(isTwitchUser))];
}

function syncMirrors(data: JsonObject, user: User): void {
  const values: Record<(typeof MIRRORED)[number], unknown> = {
    color: user.color,
    role: user.role,
    subscriber: user.subscribed,
    subscriptionTier: user.subscriptionTier,
    monthsSubscribed: user.monthsSubscribed,
    badges: user.badges,
  };
  const legacy = data.message && typeof data.message === 'object' ? (data.message as JsonObject) : undefined;
  for (const key of MIRRORED) {
    if (legacy && key in legacy) legacy[key] = values[key];
    if (key in data && key !== 'badges') data[key] = values[key];
  }
  if (Array.isArray(data.badges)) data.badges = user.badges;
}

function setRole(user: User, role: number): void {
  user.role = role;
  user.isVip = role === ROLE.vip;
  user.isModerator = role >= ROLE.moderator;
  user.isBroadcaster = role === ROLE.broadcaster;
}

/** Highest version of a months-keyed badge set not above `months` (subscriber badges: "0","3",…, "2003", "3006"…). */
function subBadgeVersion(versions: Map<string, string>, tier: string, months: number): string | undefined {
  const offset = tier === '3000' ? 3000 : tier === '2000' ? 2000 : 0;
  const candidates = [...versions.keys()]
    .map(Number)
    .filter((v) => Number.isFinite(v) && v >= offset && v < offset + 1000 && v - offset <= months)
    .sort((a, b) => b - a);
  return candidates.length ? String(candidates[0]) : versions.has('0') ? '0' : undefined;
}

export class Enricher {
  readonly config: EnrichmentConfig;
  readonly directory: TwitchDirectory;
  #channel: () => ChannelRef;

  constructor(config: EnrichmentConfig, channel: () => ChannelRef) {
    this.config = config;
    this.#channel = channel;
    this.directory = new TwitchDirectory({ ivr: config.ivrBaseUrl, sevenTv: config.sevenTvBaseUrl, bttv: config.bttvBaseUrl });
  }

  /** Prefetches channel-wide data so the first events don't wait on it. */
  async warm(): Promise<void> {
    if (!this.config.enabled) return;
    const channel = this.#channel();
    if (!channel.login) return;
    await Promise.allSettled([
      this.config.rolesAndSubs ? this.directory.modVip(channel.login) : undefined,
      this.config.badges ? this.directory.badges(channel.login) : undefined,
      this.config.emotes ? this.directory.emotes(channel) : undefined,
    ]);
  }

  /** Mutates `event.data` in place. Never throws. */
  async enrich(event: SbEventOut, hints: EnrichHints = {}): Promise<void> {
    if (!this.config.enabled || event.source !== 'Twitch' || !event.data || typeof event.data !== 'object') return;
    const data = event.data as JsonObject;
    const channel = this.#channel();
    await Promise.allSettled([
      ...usersOf(data).map((user) => this.#enrichUser(data, user, channel, hints)),
      this.#enrichParts(data, channel),
    ]);
  }

  async #enrichUser(data: JsonObject, user: User, channel: ChannelRef, hints: EnrichHints): Promise<void> {
    const login = user.login.toLowerCase();
    if (!login) return;

    if (this.config.users && (!user.id || PLACEHOLDER_ID.test(user.id) || !user.color || !user.profileImageUrl)) {
      const info = await this.directory.user(login).catch(() => undefined);
      if (info) {
        if (!user.id || PLACEHOLDER_ID.test(user.id)) {
          if (user.id) replaceDeep(data, user.id, info.id);
          user.id = info.id;
        }
        if (!user.color && info.chatColor) user.color = info.chatColor;
        if (!user.profileImageUrl && info.logo) user.profileImageUrl = info.logo;
      }
    }

    if (this.config.rolesAndSubs && channel.login) {
      if (login === channel.login.toLowerCase()) {
        setRole(user, ROLE.broadcaster);
      } else if ((user.role ?? ROLE.viewer) < ROLE.moderator) {
        const lists = await this.directory.modVip(channel.login).catch(() => undefined);
        if (lists?.mods.has(login)) setRole(user, ROLE.moderator);
        else if (lists?.vips.has(login) && (user.role ?? ROLE.viewer) < ROLE.vip) setRole(user, ROLE.vip);
      }
      if (hints.unknownSubscription && !user.subscribed && login !== channel.login.toLowerCase()) {
        const sub = await this.directory.sub(login, channel.login).catch(() => undefined);
        if (sub?.subscribed) {
          user.subscribed = true;
          user.subscriptionTier = sub.tier;
          user.monthsSubscribed = sub.months;
        }
      }
    }

    if (this.config.badges) {
      const sets = await this.directory.badges(channel.login || undefined).catch(() => undefined);
      if (sets) user.badges = this.#badgesFor(user, sets);
    }

    if (data.user === user) syncMirrors(data, user);
  }

  /**
   * Resolves images for named badges, and adds the role and sub badges Twitch
   * always displays (broadcaster/moderator/VIP, subscriber) if they're missing.
   */
  #badgesFor(user: User, sets: BadgeSets): SbBadge[] {
    const image = (name: string, version: string) => {
      const versions = sets.get(name);
      if (!versions) return '';
      if (name === 'subscriber' || name === 'founder') {
        const v = versions.has(version) ? version : subBadgeVersion(versions, user.subscriptionTier ?? '1000', Number(version) || user.monthsSubscribed || 0);
        return (v && versions.get(v)) ?? '';
      }
      return versions.get(version) ?? versions.get('1') ?? [...versions.values()][0] ?? '';
    };

    const existing = (user.badges ?? []).map((b) => (b.imageUrl ? b : { ...b, imageUrl: image(b.name, b.version) }));
    const has = (name: string) => existing.some((b) => b.name === name);
    const derived = (name: string, version: string): SbBadge[] => {
      if (has(name)) return [];
      const imageUrl = image(name, version);
      return imageUrl ? [{ name, version, imageUrl }] : [];
    };
    const role =
      user.role === ROLE.broadcaster ? derived('broadcaster', '1')
      : user.role === ROLE.moderator ? derived('moderator', '1')
      : user.role === ROLE.vip ? derived('vip', '1')
      : [];
    // Founders show the founder badge in place of the subscriber badge.
    const sub = user.subscribed && !has('founder') ? derived('subscriber', String(user.monthsSubscribed ?? 0)) : [];
    return [...role, ...sub, ...existing];
  }

  async #enrichParts(data: JsonObject, channel: ChannelRef): Promise<void> {
    if (!Array.isArray(data.parts)) return;
    let parts = data.parts as SbMessagePart[];

    for (const part of parts) {
      if (part.type === 'cheer' && !part.imageUrl) {
        const prefix = part.text.replace(/\d+$/, '').toLowerCase() || 'cheer';
        const tier = CHEER_TIERS.find((t) => part.bits >= t) ?? 1;
        part.imageUrl = `https://d3aqoihi2n8ty8.cloudfront.net/actions/${prefix}/dark/animated/${tier}/4.gif`;
      }
    }

    if (this.config.emotes && parts.some((p) => p.type === 'text')) {
      const emotes = await this.directory.emotes(channel).catch(() => undefined);
      if (emotes?.size) {
        parts = splitEmotes(parts, emotes);
        data.parts = parts;
        const emoteList = legacyEmotes(parts);
        if (Array.isArray(data.emotes)) data.emotes = emoteList;
        const legacy = data.message as JsonObject | undefined;
        if (legacy && typeof legacy === 'object' && Array.isArray(legacy.emotes)) legacy.emotes = emoteList;
      }
    }
  }
}

/** Splits text parts on whitespace and turns known emote codes into emote parts. */
export function splitEmotes(parts: SbMessagePart[], emotes: Map<string, EmoteInfo>): SbMessagePart[] {
  const out: SbMessagePart[] = [];
  for (const part of parts) {
    if (part.type !== 'text') {
      out.push(part);
      continue;
    }
    for (const token of part.text.split(/(\s+)/)) {
      if (!token) continue;
      const emote = emotes.get(token);
      const last = out.at(-1);
      if (emote) out.push({ type: 'emote', text: token, imageUrl: emote.imageUrl, source: emote.source, id: emote.id });
      else if (last?.type === 'text') last.text += token;
      else out.push({ type: 'text', text: token });
    }
  }
  return out;
}
