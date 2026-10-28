/**
 * Simple per-trigger routes for Aitum's "Send Webhook" action:
 * `POST /ingest/aitum/<platform>/<trigger>` with a flat body of trigger
 * variables, e.g. {"username": "{TWITCH:username}", "message": "..."}.
 * Trigger names follow Aitum's trigger docs (app.aitum.help/devices/...).
 * User guide: docs/aitum.md.
 */
import { randomUUID } from 'node:crypto';
import type { SbEventOut } from '../../core/types.ts';
import type { Channel, TwitchUser } from '../../sb/payloads/twitch.ts';
import * as tw from '../../sb/payloads/twitch.ts';
import * as yt from '../../sb/payloads/youtube.ts';
import { bool, num, str, type Fields } from '../shared/webhook-fields.ts';

interface TriggerDef {
  /** Body keys this trigger accepts; also drives the lenient parser. */
  keys: string[];
  map(f: Fields, channel: Channel): SbEventOut[];
}

/** Aitum only exposes display names, so login and id are derived from them. */
function twitchUser(name: unknown): TwitchUser {
  const display = str(name, 'Unknown User');
  const login = display.toLowerCase();
  return { id: `aitum-${login}`, login, name: display };
}

function youtubeUser(f: Fields): yt.YouTubeUser {
  const name = str(f.username, 'Unknown User');
  return {
    id: str(f.channelId) || `aitum-${name.toLowerCase()}`,
    name,
    profileImageUrl: str(f.profileImageUrl),
    channelUrl: str(f.channelUrl),
    isOwner: bool(f.isBroadcaster),
    isModerator: bool(f.isModerator),
    isSponsor: bool(f.isMember),
    isVerified: bool(f.isVerified),
  };
}

const twitch = (type: string, data: unknown): SbEventOut[] => [{ source: 'Twitch', type, data }];
const youtube = (type: string, data: unknown): SbEventOut[] => [{ source: 'YouTube', type, data }];

function hypeTrain(f: Fields): Fields {
  const progress = num(f.progress);
  return { level: num(f.level, 1), progress, percent: progress, percentDecimal: progress / 100 };
}

const YT_USER_KEYS = ['username', 'isVerified', 'isBroadcaster', 'isModerator', 'isMember', 'profileImageUrl', 'channelUrl', 'channelId'];

export const AITUM_TRIGGERS: Record<string, TriggerDef> = {
  'twitch/chat-message': {
    keys: ['username', 'message'],
    map: (f, channel) =>
      twitch('ChatMessage', tw.chatMessage({ messageId: randomUUID(), text: str(f.message), user: twitchUser(f.username), channel })),
  },
  'twitch/follow': {
    keys: ['username'],
    map: (f) => twitch('Follow', tw.follow(twitchUser(f.username))),
  },
  'twitch/subscription': {
    keys: ['username', 'tier', 'message', 'months'],
    map: (f) => {
      const user = twitchUser(f.username);
      const months = num(f.months, 1);
      if (months > 1) return twitch('ReSub', tw.reSub(user, num(f.tier, 1), { cumulative: months }, str(f.message)));
      return twitch('Sub', tw.sub(user, num(f.tier, 1), str(f.message)));
    },
  },
  'twitch/gift-subscription': {
    keys: ['gifter', 'tier', 'totalGifts', 'recipient'],
    map: (f) => {
      const gifter = twitchUser(f.gifter);
      const count = num(f.totalGifts, 1);
      if (count > 1) {
        return twitch('GiftBomb', tw.giftBomb({ gifter, count, plan: num(f.tier, 1), recipients: [] }));
      }
      return twitch('GiftSub', tw.giftSub({ gifter, recipient: twitchUser(f.recipient ?? 'a viewer'), plan: num(f.tier, 1) }));
    },
  },
  'twitch/bit-cheer': {
    keys: ['username', 'bits', 'message'],
    map: (f, channel) => {
      const text = str(f.message);
      return twitch('Cheer', tw.cheer({ messageId: randomUUID(), text, user: twitchUser(f.username), channel, bits: num(f.bits) }));
    },
  },
  'twitch/channel-point-redemption': {
    keys: ['redemption', 'username', 'cost', 'userInput'],
    map: (f) =>
      twitch(
        'RewardRedemption',
        tw.rewardRedemption({
          redemptionId: randomUUID(),
          user: twitchUser(f.username),
          reward: { id: str(f.redemption).toLowerCase(), title: str(f.redemption), cost: num(f.cost) },
          userInput: str(f.userInput),
        }),
      ),
  },
  'twitch/incoming-raid': {
    keys: ['raidingChannel', 'viewers'],
    map: (f, channel) => twitch('Raid', tw.raid(twitchUser(f.raidingChannel), num(f.viewers), channel)),
  },
  'twitch/hype-train-started': { keys: ['level', 'progress'], map: (f) => twitch('HypeTrainStart', hypeTrain(f)) },
  'twitch/hype-train-progress': { keys: ['level', 'progress'], map: (f) => twitch('HypeTrainUpdate', hypeTrain(f)) },
  'twitch/hype-train-level-change': { keys: ['level'], map: (f) => twitch('HypeTrainLevelUp', hypeTrain(f)) },
  'twitch/hype-train-ended': { keys: ['level'], map: (f) => twitch('HypeTrainEnd', hypeTrain(f)) },
  'twitch/shoutout-received': {
    keys: ['channel', 'viewerCount'],
    map: (f) => twitch('ShoutoutReceived', { user: tw.userObject(twitchUser(f.channel)), viewerCount: num(f.viewerCount) }),
  },
  'twitch/ad-starting': {
    keys: ['length', 'scheduled'],
    map: (f) => twitch('AdRun', { length_seconds: num(f.length), is_automatic: !bool(f.scheduled) }),
  },

  'youtube/chat-message-added': {
    keys: ['message', ...YT_USER_KEYS],
    map: (f) => youtube('Message', yt.message(youtubeUser(f), str(f.message))),
  },
  'youtube/super-chat': {
    keys: ['comment', 'amount', 'amountMicros', 'currency', 'tier', ...YT_USER_KEYS],
    map: (f) =>
      youtube(
        'SuperChat',
        yt.superChat({
          user: youtubeUser(f),
          amount: str(f.amount),
          microAmount: num(f.amountMicros),
          currencyCode: str(f.currency),
          message: str(f.comment),
          tier: num(f.tier, 1),
        }),
      ),
  },
  'youtube/super-sticker': {
    keys: ['amount', 'amountMicros', 'currency', 'tier', ...YT_USER_KEYS],
    map: (f) =>
      youtube(
        'SuperSticker',
        yt.superChat({ user: youtubeUser(f), amount: str(f.amount), microAmount: num(f.amountMicros), currencyCode: str(f.currency), tier: num(f.tier, 1) }),
      ),
  },
  'youtube/new-membership': {
    keys: ['levelName', ...YT_USER_KEYS],
    map: (f) => youtube('NewSponsor', yt.newSponsor(youtubeUser(f), str(f.levelName))),
  },
  'youtube/upgraded-membership': {
    keys: ['levelName', ...YT_USER_KEYS],
    map: (f) => youtube('NewSponsor', yt.newSponsor(youtubeUser(f), str(f.levelName), true)),
  },
  'youtube/member-milestone-chat': {
    keys: ['months', 'comment', 'levelName', ...YT_USER_KEYS],
    map: (f) =>
      youtube('MemberMileStone', yt.memberMilestone(youtubeUser(f), { months: num(f.months), levelName: str(f.levelName), message: str(f.comment) })),
  },
};
