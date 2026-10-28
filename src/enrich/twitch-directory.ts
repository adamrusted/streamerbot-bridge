/**
 * Public, unauthenticated Twitch data:
 *  - api.ivr.fi/v2: users, a channel's mods/VIPs, sub age, badges, channel emotes
 *  - 7tv.io/v3, api.betterttv.net/3 (BTTV + cached FFZ): third-party emotes
 * Response shapes were checked against the live APIs (see docs/protocol-notes.md).
 */
import { getJson, TtlCache } from './lookup.ts';

const HOUR = 60 * 60_000;

export interface TwitchUserInfo {
  id: string;
  login: string;
  displayName: string;
  chatColor: string | null;
  logo: string;
  isPartner: boolean;
  isAffiliate: boolean;
}

export interface SubInfo {
  subscribed: boolean;
  /** "1000" | "2000" | "3000" */
  tier: string;
  months: number;
}

export interface BadgeVersion {
  id: string;
  imageUrl: string;
}

export interface EmoteInfo {
  imageUrl: string;
  source: string;
  id: string;
}

/** Badge set id → version id → image URL. */
export type BadgeSets = Map<string, Map<string, string>>;

/** Twitch global emotes (ids verified via ivr.fi). Helix lists these, but needs auth. */
const TWITCH_GLOBAL_EMOTES: Record<string, string> = {
  Kappa: '25', Keepo: '1902', LUL: '425618', Kreygasm: '41', ResidentSleeper: '245', '4Head': '354',
  DansGame: '33', SeemsGood: '64138', NotLikeThis: '58765', TriHard: '120232', HeyGuys: '30259',
  CoolStoryBob: '123171', VoHiYo: '81274', PJSalt: '36', FailFish: '360', SMOrc: '52', BabyRage: '22639',
  WutFace: '28087', Jebaited: '114836', KomodoHype: '81273', CoolCat: '58127', PogChamp: '305954156',
  Kappu: '160397', KappaPride: '55338', BloodTrail: '69', MrDestructoid: '28', PopCorn: '724216',
  TwitchUnity: '196892', HSWP: '446979', GlitchCat: '304486301', StinkyCheese: '90076', CorgiDerp: '49106',
};

export const twitchEmoteUrl = (id: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

export interface DirectoryUrls {
  ivr: string;
  sevenTv: string;
  bttv: string;
}

export class TwitchDirectory {
  #urls: DirectoryUrls;
  #users = new TtlCache<TwitchUserInfo | undefined>(6 * HOUR);
  #modVip = new TtlCache<{ mods: Set<string>; vips: Set<string> }>(10 * 60_000);
  #subs = new TtlCache<SubInfo | undefined>(30 * 60_000);
  #badges = new TtlCache<BadgeSets>(6 * HOUR);
  #emotes = new TtlCache<Map<string, EmoteInfo>>(30 * 60_000);

  constructor(urls: DirectoryUrls) {
    this.#urls = urls;
  }

  user(login: string): Promise<TwitchUserInfo | undefined> {
    const key = login.toLowerCase();
    return this.#users.get(key, async () => {
      const list = (await getJson(`${this.#urls.ivr}/twitch/user?login=${encodeURIComponent(key)}`)) as any[] | undefined;
      const u = list?.[0];
      if (!u?.id) return undefined;
      return {
        id: String(u.id),
        login: String(u.login),
        displayName: String(u.displayName ?? u.login),
        chatColor: u.chatColor ?? null,
        logo: String(u.logo ?? ''),
        isPartner: Boolean(u.roles?.isPartner),
        isAffiliate: Boolean(u.roles?.isAffiliate),
      };
    });
  }

  modVip(channelLogin: string) {
    return this.#modVip.get(channelLogin.toLowerCase(), async () => {
      const d = (await getJson(`${this.#urls.ivr}/twitch/modvip/${encodeURIComponent(channelLogin.toLowerCase())}`)) as any;
      const logins = (list: unknown) => new Set(Array.isArray(list) ? list.map((x: any) => String(x.login).toLowerCase()) : []);
      return { mods: logins(d?.mods), vips: logins(d?.vips) };
    });
  }

  sub(userLogin: string, channelLogin: string): Promise<SubInfo | undefined> {
    const key = `${userLogin.toLowerCase()}@${channelLogin.toLowerCase()}`;
    return this.#subs.get(key, async () => {
      const d = (await getJson(
        `${this.#urls.ivr}/twitch/subage/${encodeURIComponent(userLogin.toLowerCase())}/${encodeURIComponent(channelLogin.toLowerCase())}`,
      )) as any;
      if (!d) return undefined;
      // `meta` is null when not currently subscribed; `cumulative` can still describe a past sub.
      if (!d.meta) return { subscribed: false, tier: '0', months: Number(d.cumulative?.months ?? 0) };
      const tier = d.meta.type === 'prime' ? '1000' : `${String(d.meta.tier ?? '1')[0]}000`;
      return { subscribed: true, tier, months: Number(d.cumulative?.months ?? 1) };
    });
  }

  /** Channel badges (when a channel is given) layered over global badges. */
  badges(channelLogin?: string): Promise<BadgeSets> {
    const key = channelLogin?.toLowerCase() ?? '';
    return this.#badges.get(key, async () => {
      const toSets = (list: unknown, into: BadgeSets) => {
        for (const set of Array.isArray(list) ? list : []) {
          const versions = into.get(set.set_id) ?? new Map<string, string>();
          for (const v of set.versions ?? []) versions.set(String(v.id), v.image_url_2x ?? v.image_url_1x);
          into.set(set.set_id, versions);
        }
        return into;
      };
      const sets = toSets(await getJson(`${this.#urls.ivr}/twitch/badges/global`), new Map());
      if (!key) return sets;
      // A channel's subscriber/bits sets replace the global ones entirely.
      const channel = toSets(await getJson(`${this.#urls.ivr}/twitch/badges/channel?login=${encodeURIComponent(key)}`), new Map());
      for (const [setId, versions] of channel) sets.set(setId, versions);
      return sets;
    });
  }

  /**
   * Every emote code usable in the channel. Later entries win: FFZ, BTTV, 7TV
   * (global, then channel), then Twitch's own globals and channel emotes, since
   * Twitch renders its emotes ahead of any third-party code.
   */
  emotes(channel: { login: string; id: string }): Promise<Map<string, EmoteInfo>> {
    return this.#emotes.get(`${channel.login.toLowerCase()}#${channel.id}`, async () => {
      const map = new Map<string, EmoteInfo>();
      const settle = <T>(p: Promise<T>) => p.catch(() => undefined);
      const { ivr, sevenTv, bttv } = this.#urls;
      const [twitchChannel, stvGlobal, stvChannel, bttvGlobal, bttvChannel, ffzGlobal, ffzChannel] = await Promise.all([
        channel.login ? settle(getJson(`${ivr}/twitch/emotes/channel/${encodeURIComponent(channel.login.toLowerCase())}`)) : undefined,
        settle(getJson(`${sevenTv}/emote-sets/global`)),
        channel.id ? settle(getJson(`${sevenTv}/users/twitch/${channel.id}`)) : undefined,
        settle(getJson(`${bttv}/cached/emotes/global`)),
        channel.id ? settle(getJson(`${bttv}/cached/users/twitch/${channel.id}`)) : undefined,
        settle(getJson(`${bttv}/cached/frankerfacez/emotes/global`)),
        channel.id ? settle(getJson(`${bttv}/cached/frankerfacez/users/twitch/${channel.id}`)) : undefined,
      ]);

      const add = (code: unknown, info: EmoteInfo) => {
        if (typeof code === 'string' && code && info.imageUrl) map.set(code, info);
      };
      const sevenTvSet = (set: any) => {
        for (const e of set?.emotes ?? []) {
          const host = e.data?.host?.url;
          if (host) add(e.name, { imageUrl: `https:${host}/2x.webp`, source: '7TV', id: String(e.id) });
        }
      };
      const bttvList = (list: unknown) => {
        for (const e of Array.isArray(list) ? list : []) add(e.code, { imageUrl: `https://cdn.betterttv.net/emote/${e.id}/2x`, source: 'BTTV', id: String(e.id) });
      };
      const ffzList = (list: unknown) => {
        for (const e of Array.isArray(list) ? list : []) {
          add(e.code, { imageUrl: e.images?.['2x'] ?? e.images?.['1x'] ?? '', source: 'FFZ', id: String(e.id) });
        }
      };
      ffzList(ffzGlobal);
      bttvList(bttvGlobal);
      sevenTvSet(stvGlobal);
      ffzList(ffzChannel);
      bttvList((bttvChannel as any)?.channelEmotes);
      bttvList((bttvChannel as any)?.sharedEmotes);
      sevenTvSet((stvChannel as any)?.emote_set);
      for (const [code, id] of Object.entries(TWITCH_GLOBAL_EMOTES)) add(code, { imageUrl: twitchEmoteUrl(id), source: 'Twitch', id });
      for (const product of (twitchChannel as any)?.subProducts ?? []) {
        for (const e of product.emotes ?? []) add(e.code, { imageUrl: twitchEmoteUrl(e.id), source: 'Twitch', id: String(e.id) });
      }
      return map;
    });
  }
}
