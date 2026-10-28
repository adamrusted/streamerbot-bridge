/**
 * Builders for Streamer.bot Twitch event payloads.
 *
 * Streamer.bot changed payload shapes between 0.2.x and 1.x (e.g. ChatMessage
 * moved from `data.message.{...}` to `data.user` / `data.text` / `data.parts`).
 * Widgets in the wild read both, so every builder emits a superset: the 1.x
 * fields plus the legacy fields, whenever the two don't collide.
 */
import type { JsonObject } from '../../core/types.ts';

export const ROLE = { viewer: 1, vip: 2, moderator: 3, broadcaster: 4 } as const;

export interface SbBadge {
  name: string;
  version: string;
  imageUrl: string;
}

export type SbMessagePart =
  | { type: 'text'; text: string }
  | { type: 'emote'; text: string; imageUrl: string; source: string; id?: string }
  | { type: 'cheer'; text: string; bits: number; imageUrl?: string }
  | { type: 'mention'; text: string };

export interface TwitchUser {
  id: string;
  login: string;
  name: string;
  color?: string;
  role?: number;
  subscribed?: boolean;
  /** "1000" | "2000" | "3000" */
  subscriptionTier?: string;
  monthsSubscribed?: number;
  badges?: SbBadge[];
}

export interface Channel {
  id: string;
  login: string;
  name: string;
}

export function userObject(user: TwitchUser): JsonObject {
  const role = user.role ?? ROLE.viewer;
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    type: 'twitch',
    role,
    subscribed: user.subscribed ?? false,
    subscriptionTier: user.subscriptionTier ?? (user.subscribed ? '1000' : '0'),
    monthsSubscribed: user.monthsSubscribed ?? 0,
    badges: user.badges ?? [],
    color: user.color ?? '',
    isVip: role === ROLE.vip,
    isModerator: role >= ROLE.moderator,
    isBroadcaster: role === ROLE.broadcaster,
  };
}

/** Normalizes "1000", "Prime", 2, "tier 3", etc. into Streamer.bot 1.x tier strings. */
export function normalizeTier(plan: unknown): { subTier: string; isPrime: boolean } {
  const text = String(plan ?? '').toLowerCase();
  if (text.includes('prime')) return { subTier: '1000', isPrime: true };
  const digit = text.match(/[123]/)?.[0] ?? '1';
  return { subTier: `${digit}000`, isPrime: false };
}

export function textParts(text: string): SbMessagePart[] {
  return text ? [{ type: 'text', text }] : [];
}

const CHEERMOTE = /^(cheer|biblethump|cheerwhal|corgo|uni|showlove|party|seemsgood|pride|kappa|frankerz|heyguys|dansgame|elegiggle|trihard|kreygasm|4head|swiftrage|notlikethis|failfish|vohiyo|pjsalt|mrdestructoid|bday|ripcheer|shamrock|streamlabs|muxy|holidaycheer|goal|anon)(\d+)$/i;

/** Emote positions in a message, as code-point indices (inclusive), like Twitch IRC's `emotes` tag. */
export interface EmoteRange {
  id: string;
  start: number;
  end: number;
}

/** Parses Twitch IRC's emote format: `25:0-4,12-16/1902:6-10`. */
export function parseEmoteList(list: string): EmoteRange[] {
  const ranges: EmoteRange[] = [];
  for (const group of list.split('/')) {
    const [id, positions] = group.trim().split(':');
    if (!id || !positions) continue;
    for (const pos of positions.split(',')) {
      const [start, end] = pos.split('-').map(Number);
      if (Number.isInteger(start) && Number.isInteger(end)) ranges.push({ id, start, end });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Builds parts from plain text: Twitch emotes at the given positions, cheermote tokens, the rest as text. */
export function partsFromText(text: string, emotes: EmoteRange[] = []): SbMessagePart[] {
  const chars = [...text];
  const parts: SbMessagePart[] = [];
  const pushText = (chunk: string) => {
    for (const token of chunk.split(/(\s+)/)) {
      if (!token) continue;
      const match = token.match(CHEERMOTE);
      const last = parts.at(-1);
      if (match) parts.push({ type: 'cheer', text: token, bits: Number(match[2]) });
      else if (last?.type === 'text') last.text += token;
      else parts.push({ type: 'text', text: token });
    }
  };
  let index = 0;
  for (const emote of emotes) {
    if (emote.start < index || emote.end >= chars.length) continue;
    pushText(chars.slice(index, emote.start).join(''));
    parts.push({
      type: 'emote',
      text: chars.slice(emote.start, emote.end + 1).join(''),
      imageUrl: `https://static-cdn.jtvnw.net/emoticons/v2/${emote.id}/default/dark/2.0`,
      source: 'Twitch',
      id: emote.id,
    });
    index = emote.end + 1;
  }
  pushText(chars.slice(index).join(''));
  return parts;
}

/** Legacy `emotes` array (with string indices) derived from message parts. */
export function legacyEmotes(parts: SbMessagePart[]): JsonObject[] {
  const emotes: JsonObject[] = [];
  let index = 0;
  for (const part of parts) {
    const length = [...part.text].length;
    if (part.type === 'emote') {
      emotes.push({
        id: part.id ?? '',
        type: part.source,
        name: part.text,
        startIndex: index,
        endIndex: index + length - 1,
        imageUrl: part.imageUrl,
      });
    }
    index += length;
  }
  return emotes;
}

export interface ChatMessageInput {
  messageId: string;
  text: string;
  parts?: SbMessagePart[];
  user: TwitchUser;
  channel: Channel;
  firstMessage?: boolean;
  isMe?: boolean;
  isHighlighted?: boolean;
  isCustomReward?: boolean;
  bits?: number;
  reply?: { msgId: string; userId: string; userLogin: string; userName: string; msgBody: string };
  /** Set when the message arrived from another channel in a Shared Chat session. */
  sharedChatSource?: Channel;
}

export function chatMessage(input: ChatMessageInput): JsonObject {
  const bits = input.bits ?? 0;
  // Only look for cheermotes in messages that actually carry bits.
  const parts = input.parts?.length ? input.parts : bits > 0 ? partsFromText(input.text) : textParts(input.text);
  const user = userObject(input.user);
  const emotes = legacyEmotes(parts);
  const meta = {
    internal: false,
    firstMessage: input.firstMessage ?? false,
    isMe: input.isMe ?? false,
    isHighlighted: input.isHighlighted ?? false,
    isCustomReward: input.isCustomReward ?? false,
    isAnonymous: false,
    isTest: false,
  };

  return {
    messageId: input.messageId,
    text: input.text,
    parts,
    user,
    meta,
    bits,
    isReply: Boolean(input.reply),
    reply: input.reply ?? null,
    isSharedChat: Boolean(input.sharedChatSource),
    isFromSharedChatGuest: Boolean(input.sharedChatSource),
    sharedChatSource: input.sharedChatSource ?? null,
    broadcaster: input.channel,
    emotes,
    cheerEmotes: [],
    // Streamer.bot 0.2.x shape
    message: {
      internal: false,
      msgId: input.messageId,
      userId: input.user.id,
      username: input.user.login,
      role: user.role,
      subscriber: user.subscribed,
      subscriptionTier: user.subscriptionTier,
      displayName: input.user.name,
      color: user.color,
      channel: input.channel.login,
      message: input.text,
      isHighlighted: meta.isHighlighted,
      isMe: meta.isMe,
      isCustomReward: meta.isCustomReward,
      isAnonymous: false,
      isReply: Boolean(input.reply),
      bits,
      firstMessage: meta.firstMessage,
      hasBits: bits > 0,
      emotes,
      cheerEmotes: [],
      badges: user.badges,
      monthsSubscribed: user.monthsSubscribed,
      isTest: false,
    },
  };
}

export function cheer(input: ChatMessageInput & { bits: number; isAnonymous?: boolean }): JsonObject {
  const base = chatMessage(input);
  const legacy = base.message as JsonObject;
  // 0.2.x Cheer was flat (no `message` wrapper) and used `message` for the text.
  return { ...legacy, ...base, message: input.text, isAnonymous: input.isAnonymous ?? false };
}

export function announcement(input: ChatMessageInput & { color?: string }): JsonObject {
  return { ...chatMessage(input), announcementColor: (input.color ?? 'PRIMARY').toUpperCase() };
}

export function follow(user: TwitchUser, followedAt = new Date().toISOString()): JsonObject {
  const u = userObject(user);
  return {
    user_id: user.id,
    user_login: user.login,
    user_name: user.name,
    followed_at: followedAt,
    user: u,
    targetUser: u,
  };
}

/** Fields common to the 0.2.x Sub/ReSub/GiftSub payloads. */
function legacySubFields(user: TwitchUser, tier: string, text: string): JsonObject {
  return {
    userId: user.id,
    userName: user.login,
    displayName: user.name,
    role: user.role ?? ROLE.viewer,
    message: text,
    emotes: [],
    badges: user.badges ?? [],
    isTest: false,
    // 0.2.x used a numeric tier (0 = prime)
    tier: Number(tier[0]),
  };
}

export function sub(user: TwitchUser, plan: unknown, text = ''): JsonObject {
  const { subTier, isPrime } = normalizeTier(plan);
  return {
    ...legacySubFields(user, subTier, text),
    user: userObject({ ...user, subscribed: true, subscriptionTier: subTier }),
    subTier,
    sub_tier: subTier,
    isPrime,
    is_prime: isPrime,
    is_gift: false,
    durationMonths: 1,
    text,
    parts: textParts(text),
  };
}

export function reSub(
  user: TwitchUser,
  plan: unknown,
  months: { cumulative: number; streak?: number },
  text = '',
): JsonObject {
  const { subTier, isPrime } = normalizeTier(plan);
  return {
    ...legacySubFields(user, subTier, text),
    user: userObject({ ...user, subscribed: true, subscriptionTier: subTier, monthsSubscribed: months.cumulative }),
    subTier,
    isPrime,
    cumulativeMonths: months.cumulative,
    streakMonths: months.streak ?? 0,
    shareStreak: Boolean(months.streak),
    durationMonths: 1,
    text,
    parts: textParts(text),
  };
}

export function giftSub(input: {
  gifter: TwitchUser;
  recipient: TwitchUser;
  plan: unknown;
  monthsGifted?: number;
  totalGifted?: number;
  isAnonymous?: boolean;
  fromSubBomb?: boolean;
}): JsonObject {
  const { subTier } = normalizeTier(input.plan);
  const total = input.totalGifted ?? 0;
  return {
    ...legacySubFields(input.gifter, subTier, ''),
    user: userObject(input.gifter),
    recipient: userObject(input.recipient),
    subTier,
    isAnonymous: input.isAnonymous ?? false,
    monthsGifted: input.monthsGifted ?? 1,
    // 1.x spells it "cumlative"; both are sent.
    cumlativeTotal: total,
    cumulativeTotal: total,
    totalSubsGifted: total,
    fromSubBomb: input.fromSubBomb ?? false,
    subBombCount: 0,
    recipientUserId: input.recipient.id,
    recipientUsername: input.recipient.login,
    recipientDisplayName: input.recipient.name,
  };
}

export function giftBomb(input: {
  gifter: TwitchUser;
  count: number;
  plan: unknown;
  recipients: TwitchUser[];
  totalGifted?: number;
  isAnonymous?: boolean;
}): JsonObject {
  const { subTier } = normalizeTier(input.plan);
  return {
    ...legacySubFields(input.gifter, subTier, ''),
    user: userObject(input.gifter),
    subTier,
    gifts: input.count,
    total: input.count,
    cumulativeTotal: input.totalGifted ?? 0,
    cumlativeTotal: input.totalGifted ?? 0,
    isAnonymous: input.isAnonymous ?? false,
    recipients: input.recipients.map(userObject),
  };
}

export function raid(from: TwitchUser, viewers: number, to: Channel): JsonObject {
  return {
    from_broadcaster_user_id: from.id,
    from_broadcaster_user_login: from.login,
    from_broadcaster_user_name: from.name,
    to_broadcaster_user_id: to.id,
    to_broadcaster_user_login: to.login,
    to_broadcaster_user_name: to.name,
    viewers,
    user: userObject(from),
  };
}

export function rewardRedemption(input: {
  redemptionId: string;
  user: TwitchUser;
  reward: { id: string; title: string; cost: number; prompt?: string };
  userInput?: string;
  redeemedAt?: string;
}): JsonObject {
  const userInput = input.userInput ?? '';
  return {
    id: input.redemptionId,
    user_id: input.user.id,
    user_login: input.user.login,
    user_name: input.user.name,
    user_input: userInput,
    userInput,
    status: 'unfulfilled',
    reward: { prompt: '', ...input.reward },
    redeemed_at: input.redeemedAt ?? new Date().toISOString(),
    user: userObject(input.user),
  };
}

export function chatMessageDeleted(input: { messageId: string; text?: string; user: TwitchUser }): JsonObject {
  return {
    messageId: input.messageId,
    targetMessageId: input.messageId,
    message: input.text ?? '',
    text: input.text ?? '',
    userName: input.user.login,
    user: userObject(input.user),
    targetUser: userObject(input.user),
  };
}

export function moderation(input: {
  target: TwitchUser;
  moderator?: string;
  reason?: string;
  durationSeconds?: number;
}): JsonObject {
  const target = userObject(input.target);
  return {
    targetUser: target,
    user: target,
    user_id: input.target.id,
    user_login: input.target.login,
    user_name: input.target.name,
    moderator: input.moderator ? { login: input.moderator, name: input.moderator } : null,
    reason: input.reason ?? '',
    duration: input.durationSeconds ?? 0,
    isPermanent: input.durationSeconds === undefined,
  };
}
