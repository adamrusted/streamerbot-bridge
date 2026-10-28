/**
 * SAMMI trigger objects → Streamer.bot events.
 *
 * A SAMMI button pulls the whole trigger object (Trigger Pull Data with an
 * empty Pull Value), stringifies it and POSTs it to
 * /ingest/sammi/event/<trigger type>. Trigger type numbers and field labels
 * come from sammi.solutions/docs (commands/trigger, triggers/twitch,
 * triggers/youtube). The docs give display labels ("User Name"), not JSON keys,
 * so keys are normalized before lookup (see normalizeKeys).
 * User guide: docs/sammi.md.
 */
import { randomUUID } from 'node:crypto';
import type { SbEventOut } from '../../core/types.ts';
import * as tw from '../../sb/payloads/twitch.ts';
import * as yt from '../../sb/payloads/youtube.ts';
import { bool, num, str, type Fields } from '../shared/webhook-fields.ts';

/** SAMMI's numeric trigger types (Trigger Pull Data → Trigger Type). */
export const TRIGGER = {
  TwitchChat: 0,
  TwitchSubscriber: 1,
  TwitchCommunityGift: 2,
  TwitchChannelPoints: 3,
  TwitchRaid: 4,
  TwitchBits: 5,
  TwitchFollower: 6,
  TwitchModeration: 11,
  TwitchHypeTrain: 17,
  YoutubeChat: 18,
  YoutubeSubscriber: 19,
  YoutubeSuperchat: 20,
  YoutubeSupersticker: 21,
  YoutubeMember: 22,
} as const;

export interface SammiContext {
  channel: tw.Channel;
  /** Last hype train level seen, to synthesize HypeTrainLevelUp (SAMMI only sends begin/progress/end). */
  hypeTrainLevel: number;
}

/** `f` has normalized keys: "username", "displayname", "userid", ... */
function twitchUser(f: Fields, prefix = ''): tw.TwitchUser {
  const login = str(f[`${prefix}username`] ?? f[`${prefix}userlogin`] ?? f[prefix || 'username']).toLowerCase();
  const role = bool(f.isbroadcaster)
    ? tw.ROLE.broadcaster
    : bool(f.ismod) || bool(f.isleadmoderator)
      ? tw.ROLE.moderator
      : bool(f.isvip)
        ? tw.ROLE.vip
        : tw.ROLE.viewer;
  return {
    id: str(f[`${prefix}userid`]) || `sammi-${login}`,
    login,
    name: str(f[`${prefix}displayname`]) || login,
    color: prefix ? '' : str(f.namecolor),
    role: prefix ? tw.ROLE.viewer : role,
    subscribed: !prefix && (bool(f.issubscriber) || bool(f.isfounder)),
    // Names only ("broadcaster/1,subscriber/0"); the enricher resolves images, and imageless badges are dropped.
    badges: prefix ? [] : parseBadgeList(str(f.badgelist)),
  };
}

function parseBadgeList(list: string): tw.SbBadge[] {
  return list
    .split(',')
    .map((entry) => entry.trim().split('/'))
    .filter(([name]) => name)
    .map(([name, version]) => ({ name, version: version ?? '1', imageUrl: '' }));
}

function youtubeUser(f: Fields): yt.YouTubeUser {
  const name = str(f.displayname, 'Unknown User');
  return {
    id: str(f.userid) || `sammi-${name.toLowerCase()}`,
    name,
    profileImageUrl: str(f.pictureurl),
    channelUrl: str(f.channelurl),
    isOwner: bool(f.isbroadcaster),
    isModerator: bool(f.ismoderator),
    isSponsor: bool(f.ismember),
    isVerified: bool(f.isverified),
  };
}

const twitch = (type: string, data: unknown): SbEventOut[] => [{ source: 'Twitch', type, data }];
const youtube = (type: string, data: unknown): SbEventOut[] => [{ source: 'YouTube', type, data }];

function chat(f: Fields, ctx: SammiContext): SbEventOut[] {
  const text = str(f.message);
  const ownChat = f.isownchat === undefined || bool(f.isownchat);
  return twitch(
    'ChatMessage',
    tw.chatMessage({
      messageId: str(f.messageid) || randomUUID(),
      text,
      parts: tw.partsFromText(text, tw.parseEmoteList(str(f.emotelist))),
      user: twitchUser(f),
      channel: ctx.channel,
      isCustomReward: Boolean(str(f.customrewardid)),
      reply: f.replyparentmessageid
        ? {
            msgId: str(f.replyparentmessageid),
            userId: str(f.replyparentuserid),
            userLogin: str(f.replyparentuserlogin),
            userName: str(f.replyparentdisplayname, str(f.replyparentuserlogin)),
            msgBody: str(f.replyparentmessagebody),
          }
        : undefined,
      sharedChatSource: ownChat ? undefined : { id: str(f.fromchannelid), login: str(f.channel), name: str(f.channel) },
    }),
  );
}

function subscription(f: Fields): SbEventOut[] {
  const context = str(f.context, 'sub').toLowerCase();
  const user = twitchUser(f);
  const plan = str(f.tier, 'Tier 1');
  if (context.includes('gift')) {
    return twitch(
      'GiftSub',
      tw.giftSub({
        gifter: user,
        recipient: twitchUser(f, 'gifted'),
        plan,
        monthsGifted: num(f.durationmonths, 1),
        totalGifted: num(f.cumulativetotal),
        isAnonymous: context.startsWith('anon'),
        fromSubBomb: bool(f.communitygift),
      }),
    );
  }
  const text = str(f.message);
  if (context === 'resub') return twitch('ReSub', tw.reSub(user, plan, { cumulative: num(f.month, 1) }, text));
  return twitch('Sub', tw.sub(user, plan, text));
}

function moderation(f: Fields): SbEventOut[] {
  const event = str(f.event).toLowerCase();
  const target = twitchUser({ username: f.targetuserlogin ?? f.target, displayname: f.targetdisplayname, userid: f.targetuserid });
  const moderator = str(f.moderatoruserlogin);
  if (event.includes('unban') || event.includes('untimeout')) return twitch('UserUnbanned', tw.moderation({ target, moderator }));
  if (event.includes('timeout')) {
    const ends = Date.parse(str(f.expiresat) || str(f.endsat));
    const durationSeconds = Number.isFinite(ends) ? Math.max(0, Math.round((ends - Date.now()) / 1000)) : 0;
    return twitch('UserTimedOut', tw.moderation({ target, moderator, reason: str(f.reason), durationSeconds }));
  }
  if (event.includes('ban')) return twitch('UserBanned', tw.moderation({ target, moderator, reason: str(f.reason) }));
  if (event.includes('clear')) return twitch('ChatCleared', { moderator });
  if (event.includes('delete')) {
    return twitch('ChatMessageDeleted', tw.chatMessageDeleted({ messageId: str(f.messageid), text: str(f.message), user: target }));
  }
  return [];
}

function hypeTrain(f: Fields, ctx: SammiContext): SbEventOut[] {
  const level = num(f.level, 1);
  const progress = num(f.progress);
  const goal = num(f.goal);
  const percent = goal > 0 ? Math.round((progress / goal) * 100) : 0;
  const data = { level, progress, goal, total: num(f.total), percent, percentDecimal: percent / 100, id: str(f.id) };
  const event = str(f.event).toLowerCase();
  if (event === 'begin') {
    ctx.hypeTrainLevel = level;
    return twitch('HypeTrainStart', data);
  }
  if (event === 'end') {
    ctx.hypeTrainLevel = 0;
    return twitch('HypeTrainEnd', data);
  }
  const out = twitch('HypeTrainUpdate', data);
  if (level > ctx.hypeTrainLevel && ctx.hypeTrainLevel > 0) out.push(...twitch('HypeTrainLevelUp', data));
  ctx.hypeTrainLevel = level;
  return out;
}

export function mapSammiTrigger(triggerType: number, f: Fields, ctx: SammiContext): SbEventOut[] | undefined {
  switch (triggerType) {
    case TRIGGER.TwitchChat:
      return chat(f, ctx);
    case TRIGGER.TwitchSubscriber:
      return subscription(f);
    case TRIGGER.TwitchCommunityGift: {
      const anonymous = str(f.username).toLowerCase() === 'ananonymousgifter';
      return twitch(
        'GiftBomb',
        tw.giftBomb({
          gifter: twitchUser(f),
          count: num(f.amount, 1),
          plan: str(f.tier, 'Tier 1'),
          recipients: [],
          totalGifted: num(f.cumulativetotal),
          isAnonymous: anonymous,
        }),
      );
    }
    case TRIGGER.TwitchChannelPoints:
      return twitch(
        'RewardRedemption',
        tw.rewardRedemption({
          redemptionId: str(f.redeemid) || randomUUID(),
          user: twitchUser(f),
          reward: { id: str(f.rewardid), title: str(f.redeemname), cost: num(f.cost) },
          userInput: str(f.message),
        }),
      );
    case TRIGGER.TwitchRaid:
      return twitch('Raid', tw.raid(twitchUser(f), num(f.amount), ctx.channel));
    case TRIGGER.TwitchBits: {
      const text = str(f.message);
      return twitch(
        'Cheer',
        tw.cheer({
          messageId: randomUUID(),
          text,
          parts: tw.partsFromText(text, tw.parseEmoteList(str(f.emotelist))),
          user: twitchUser(f),
          channel: ctx.channel,
          bits: num(f.amount),
        }),
      );
    }
    case TRIGGER.TwitchFollower:
      return twitch('Follow', tw.follow(twitchUser(f), str(f.followedat) || undefined));
    case TRIGGER.TwitchModeration:
      return moderation(f);
    case TRIGGER.TwitchHypeTrain:
      return hypeTrain(f, ctx);
    case TRIGGER.YoutubeChat:
      return youtube('Message', yt.message(youtubeUser(f), str(f.message)));
    case TRIGGER.YoutubeSubscriber:
      return youtube('NewSubscriber', { user: yt.youtubeUser(youtubeUser(f)), eventId: randomUUID() });
    case TRIGGER.YoutubeSuperchat:
    case TRIGGER.YoutubeSupersticker:
      return youtube(
        triggerType === TRIGGER.YoutubeSuperchat ? 'SuperChat' : 'SuperSticker',
        yt.superChat({
          user: youtubeUser(f),
          amount: str(f.amountasstring),
          microAmount: num(f.amount),
          currencyCode: str(f.currency),
          message: str(f.message),
          tier: num(f.tier, 1),
        }),
      );
    case TRIGGER.YoutubeMember: {
      const months = num(f.months);
      if (months > 0) {
        return youtube('MemberMileStone', yt.memberMilestone(youtubeUser(f), { months, levelName: str(f.levelname), message: str(f.message) }));
      }
      return youtube('NewSponsor', yt.newSponsor(youtubeUser(f), str(f.levelname)));
    }
  }
  return undefined;
}
