/**
 * Routes for Mix It Up's Web Request action:
 * `POST /ingest/mixitup/<event>` with a flat body of special identifiers, keyed
 * by the identifier name without its `$`, e.g. {"username": "$username"}.
 * Event identifiers come from mixitup.bot/docs (events, platforms/twitch,
 * platforms/youtube, chat, reference/special-identifiers).
 * User guide: docs/mixitup.md.
 */
import { randomUUID } from 'node:crypto';
import type { SbEventOut } from '../../core/types.ts';
import * as tw from '../../sb/payloads/twitch.ts';
import * as yt from '../../sb/payloads/youtube.ts';
import { bool, num, str, type Fields } from '../shared/webhook-fields.ts';

export interface MixItUpContext {
  channel: tw.Channel;
  /** Message ids are invented here (Mix It Up has none); deletes look them up. */
  rememberMessage(login: string, text: string, messageId: string): void;
  recallMessage(login: string, text: string): string | undefined;
}

interface EventDef {
  keys: string[];
  map(f: Fields, ctx: MixItUpContext): SbEventOut[];
}

/** Identifiers describing "the user" (`$user…`) or "the target user" (`$targetuser…`). */
const userKeys = (prefix: 'user' | 'targetuser') => {
  const base = prefix === 'user' ? 'username' : 'targetusername';
  const p = (s: string) => `${prefix}${s}`;
  return [base, p('displayname'), p('twitchid'), p('id'), p('color'), p('ismod'), p('isvip'), p('issubscriber'), p('submonths'), p('subbadge'), p('avatar'), p('primaryrole')];
};
const USER = userKeys('user');
const TARGET = userKeys('targetuser');

function twitchUser(f: Fields, prefix: 'user' | 'targetuser' = 'user'): tw.TwitchUser {
  const get = (s: string) => f[`${prefix}${s}`];
  const name = str(prefix === 'user' ? f.username : f.targetusername, 'Unknown User');
  const display = str(get('displayname')) || name;
  const login = name.toLowerCase();
  const primary = str(get('primaryrole')).toLowerCase();
  const role = /streamer|broadcaster|owner/.test(primary)
    ? tw.ROLE.broadcaster
    : bool(get('ismod')) || primary.includes('mod')
      ? tw.ROLE.moderator
      : bool(get('isvip')) || primary.includes('vip')
        ? tw.ROLE.vip
        : tw.ROLE.viewer;
  const subscribed = bool(get('issubscriber'));
  const badgeUrl = str(get('subbadge'));
  const color = str(get('color'));
  return {
    id: str(get('twitchid')) || `mixitup-${login}`,
    login,
    name: display,
    // Mix It Up falls back to black when a user has no colour set.
    color: color.toUpperCase() === '#000000' ? '' : color,
    role,
    subscribed,
    monthsSubscribed: num(get('submonths')),
    badges: subscribed && /^https?:/.test(badgeUrl) ? [{ name: 'subscriber', version: str(get('submonths'), '1'), imageUrl: badgeUrl }] : [],
  };
}

function youtubeUser(f: Fields, prefix: 'user' | 'targetuser' = 'user'): yt.YouTubeUser {
  const u = twitchUser(f, prefix);
  return {
    id: str(f[`${prefix}id`]) || u.id,
    name: u.name,
    profileImageUrl: str(f[`${prefix}avatar`]),
    isOwner: u.role === tw.ROLE.broadcaster,
    isModerator: u.role === tw.ROLE.moderator,
    isSponsor: u.subscribed,
  };
}

const twitch = (type: string, data: unknown): SbEventOut[] => [{ source: 'Twitch', type, data }];
const youtube = (type: string, data: unknown): SbEventOut[] => [{ source: 'YouTube', type, data }];

function hypeTrain(f: Fields): Fields {
  const points = num(f.hypetrainlevelpoints);
  const goal = num(f.hypetrainlevelgoal);
  const percent = goal > 0 ? Math.round((points / goal) * 100) : 0;
  return {
    level: num(f.hypetrainlevel ?? f.hypetraintotallevel, 1),
    progress: points,
    goal,
    total: num(f.hypetraintotalpoints),
    percent,
    percentDecimal: percent / 100,
  };
}

const HYPE_KEYS = ['hypetrainlevel', 'hypetrainlevelpoints', 'hypetrainlevelgoal', 'hypetraintotalpoints', 'hypetraintotallevel'];

export const MIXITUP_EVENTS: Record<string, EventDef> = {
  'chat-message': {
    keys: [...USER, 'message', 'streamingplatform'],
    map: (f, ctx) => {
      const platform = str(f.streamingplatform, 'Twitch').toLowerCase();
      const text = str(f.message);
      if (platform === 'youtube') return youtube('Message', yt.message(youtubeUser(f), text));
      if (platform !== 'twitch') return [];
      const user = twitchUser(f);
      const messageId = randomUUID();
      ctx.rememberMessage(user.login, text, messageId);
      return twitch('ChatMessage', tw.chatMessage({ messageId, text, user, channel: ctx.channel }));
    },
  },
  follow: {
    keys: USER,
    map: (f) => twitch('Follow', tw.follow(twitchUser(f))),
  },
  subscribed: {
    keys: [...USER, 'usersubplan', 'message'],
    map: (f) => twitch('Sub', tw.sub(twitchUser(f), str(f.usersubplan, 'Tier 1'), str(f.message))),
  },
  resubscribed: {
    keys: [...USER, 'usersubplan', 'usersubstreak', 'message'],
    map: (f) =>
      twitch(
        'ReSub',
        tw.reSub(twitchUser(f), str(f.usersubplan, 'Tier 1'), { cumulative: num(f.usersubmonths, 1), streak: num(f.usersubstreak) }, str(f.message)),
      ),
  },
  'subscription-gifted': {
    keys: [...USER, ...TARGET, 'usersubplan', 'usersubmonthsgifted', 'usertotalsubsgifted', 'isanonymous'],
    map: (f) =>
      twitch(
        'GiftSub',
        tw.giftSub({
          gifter: twitchUser(f),
          recipient: twitchUser(f, 'targetuser'),
          plan: str(f.usersubplan, 'Tier 1'),
          monthsGifted: num(f.usersubmonthsgifted, 1),
          totalGifted: num(f.usertotalsubsgifted),
          isAnonymous: bool(f.isanonymous),
        }),
      ),
  },
  'mass-subscriptions-gifted': {
    keys: [...USER, 'usersubplan', 'subsgiftedamount', 'subsgiftedlifetimeamount', 'isanonymous'],
    map: (f) =>
      twitch(
        'GiftBomb',
        tw.giftBomb({
          gifter: twitchUser(f),
          count: num(f.subsgiftedamount, 1),
          plan: str(f.usersubplan, 'Tier 1'),
          recipients: [],
          totalGifted: num(f.subsgiftedlifetimeamount),
          isAnonymous: bool(f.isanonymous),
        }),
      ),
  },
  'bits-cheered': {
    keys: [...USER, 'bitsamount', 'message'],
    map: (f, ctx) =>
      twitch('Cheer', tw.cheer({ messageId: randomUUID(), text: str(f.message), user: twitchUser(f), channel: ctx.channel, bits: num(f.bitsamount) })),
  },
  'channel-points-redeemed': {
    keys: [...USER, 'rewardname', 'rewardcost', 'message'],
    map: (f) =>
      twitch(
        'RewardRedemption',
        tw.rewardRedemption({
          redemptionId: randomUUID(),
          user: twitchUser(f),
          reward: { id: str(f.rewardname).toLowerCase(), title: str(f.rewardname), cost: num(f.rewardcost) },
          userInput: str(f.message),
        }),
      ),
  },
  raided: {
    keys: [...USER, 'raidviewercount'],
    map: (f, ctx) => twitch('Raid', tw.raid(twitchUser(f), num(f.raidviewercount), ctx.channel)),
  },
  'hype-train-start': { keys: HYPE_KEYS, map: (f) => twitch('HypeTrainStart', hypeTrain(f)) },
  'hype-train-progress': { keys: HYPE_KEYS, map: (f) => twitch('HypeTrainUpdate', hypeTrain(f)) },
  'hype-train-level-up': { keys: HYPE_KEYS, map: (f) => twitch('HypeTrainLevelUp', hypeTrain(f)) },
  'hype-train-end': { keys: HYPE_KEYS, map: (f) => twitch('HypeTrainEnd', hypeTrain(f)) },
  'shoutout-received': {
    keys: [...USER, 'shoutoutviewercount'],
    map: (f) => twitch('ShoutoutReceived', { user: tw.userObject(twitchUser(f)), viewerCount: num(f.shoutoutviewercount) }),
  },
  'ad-started': {
    keys: ['adduration', 'adisautomatic'],
    map: (f) => twitch('AdRun', { length_seconds: num(f.adduration), is_automatic: bool(f.adisautomatic) }),
  },
  'watch-streak': {
    keys: [...USER, 'userwatchstreak', 'message'],
    map: (f) => {
      const user = twitchUser(f);
      return twitch('WatchStreak', {
        user: tw.userObject(user),
        displayName: user.name,
        watchStreak: num(f.userwatchstreak),
        message: str(f.message),
        text: str(f.message),
      });
    },
  },
  'message-deleted': {
    keys: [...TARGET, 'message', 'reason'],
    map: (f, ctx) => {
      const target = twitchUser(f, 'targetuser');
      const text = str(f.message);
      const messageId = ctx.recallMessage(target.login, text) ?? '';
      return twitch('ChatMessageDeleted', tw.chatMessageDeleted({ messageId, text, user: target }));
    },
  },
  'user-timeout': {
    keys: [...TARGET, 'timeoutlength'],
    map: (f) => twitch('UserTimedOut', tw.moderation({ target: twitchUser(f, 'targetuser'), durationSeconds: num(f.timeoutlength) })),
  },
  'user-banned': {
    keys: TARGET,
    map: (f) => twitch('UserBanned', tw.moderation({ target: twitchUser(f, 'targetuser') })),
  },
  'stream-start': { keys: [], map: (_f, ctx) => twitch('StreamOnline', { broadcaster: ctx.channel }) },
  'stream-stop': { keys: [], map: (_f, ctx) => twitch('StreamOffline', { broadcaster: ctx.channel }) },

  'youtube-super-chat': {
    keys: [...USER, 'amount', 'amountnumber', 'currencytype', 'message', 'tier'],
    map: (f) =>
      youtube(
        'SuperChat',
        yt.superChat({
          user: youtubeUser(f),
          amount: str(f.amount),
          microAmount: Math.round(num(f.amountnumber) * 1_000_000),
          currencyCode: str(f.currencytype),
          message: str(f.message),
          tier: num(f.tier, 1),
        }),
      ),
  },
  'youtube-new-member': {
    keys: [...USER, 'usersubplan'],
    map: (f) => youtube('NewSponsor', yt.newSponsor(youtubeUser(f), str(f.usersubplan))),
  },
  'youtube-member-milestone': {
    keys: [...USER, 'usersubplan', 'message'],
    map: (f) =>
      youtube('MemberMileStone', yt.memberMilestone(youtubeUser(f), { months: num(f.usersubmonths), levelName: str(f.usersubplan), message: str(f.message) })),
  },
  'youtube-membership-gifted': {
    keys: [...USER, ...TARGET, 'usersubplan'],
    map: (f) =>
      youtube('GiftMembershipReceived', {
        ...yt.newSponsor(youtubeUser(f, 'targetuser'), str(f.usersubplan)),
        gifter: yt.youtubeUser(youtubeUser(f)),
        tier: str(f.usersubplan),
      }),
  },
};
