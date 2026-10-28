/**
 * Builders for Streamer.bot Kick event payloads. Streamer.bot publishes no Kick schema, so
 * fields follow its Twitch payloads where they overlap, plus what the Nutty multichat overlay
 * reads (see docs/protocol-notes.md). Kick badges carry Kick's own ids (`broadcaster`,
 * `moderator`, `vip`, `og`, `subscriber` with `count`…) and an `imageUrl` only when Kick gave
 * one: Nutty draws its own Kick icons for the rest.
 */
import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../../core/types.ts';
import { textParts, type SbMessagePart } from './twitch.ts';

export interface KickBadge {
  /** Kick's badge type, e.g. "moderator". */
  id: string;
  type: string;
  name: string;
  count?: number;
  imageUrl: string;
}

export interface KickUser {
  id: string;
  login: string;
  name: string;
  color?: string;
  profileImageUrl?: string;
  badges?: KickBadge[];
  isVerified?: boolean;
}

/** Streamer.bot's numeric roles (as for Twitch), from Kick badges. */
function roleOf(badges: KickBadge[]): number {
  const has = (id: string) => badges.some((b) => b.id === id);
  if (has('broadcaster')) return 4;
  if (has('moderator')) return 3;
  if (has('vip') || has('og')) return 2;
  return 1;
}

export function kickUser(user: KickUser): JsonObject {
  const badges = user.badges ?? [];
  const sub = badges.find((b) => b.id === 'subscriber');
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    displayName: user.name,
    color: user.color ?? '',
    profileImageUrl: user.profileImageUrl ?? '',
    badges: badges as unknown as JsonObject[],
    role: roleOf(badges),
    subscribed: Boolean(sub),
    monthsSubscribed: sub?.count ?? 0,
    isVerified: user.isVerified ?? false,
    platform: 'kick',
  };
}

export interface KickChatInput {
  messageId: string;
  text: string;
  parts?: SbMessagePart[];
  user: KickUser;
  firstMessage?: boolean;
  reply?: { msgId: string; userId: string; userLogin: string; userName: string; msgBody: string };
}

export function chatMessage(input: KickChatInput): JsonObject {
  const user = kickUser(input.user);
  return {
    messageId: input.messageId,
    id: input.messageId,
    text: input.text,
    message: input.text,
    parts: input.parts?.length ? input.parts : textParts(input.text),
    user,
    firstMessage: input.firstMessage ?? false,
    meta: { firstMessage: input.firstMessage ?? false, isTest: false },
    isReply: Boolean(input.reply),
    reply: input.reply ?? null,
    platform: 'kick',
  };
}

export function follow(user: KickUser): JsonObject {
  const u = kickUser(user);
  return { user: u, user_id: user.id, user_login: user.login, user_name: user.name, followed_at: new Date().toISOString() };
}

export function subscription(user: KickUser, months: number, isResub: boolean): JsonObject {
  return { eventId: randomUUID(), user: kickUser(user), months, cumulativeMonths: months, isResub };
}

export function giftSubscription(gifter: KickUser, recipient: KickUser, isAnonymous: boolean): JsonObject {
  return { eventId: randomUUID(), user: kickUser(gifter), gifter: kickUser(gifter), recipient: kickUser(recipient), isAnonymous };
}

export function massGiftSubscription(gifter: KickUser, recipients: KickUser[], isAnonymous: boolean): JsonObject {
  return {
    eventId: randomUUID(),
    user: kickUser(gifter),
    gifter: kickUser(gifter),
    recipients: recipients.map(kickUser),
    count: recipients.length,
    total: recipients.length,
    isAnonymous,
  };
}

export function moderation(input: { target: KickUser; moderator: string; reason?: string; durationSeconds?: number }): JsonObject {
  return {
    user: kickUser(input.target),
    targetUser: kickUser(input.target),
    moderator: input.moderator,
    reason: input.reason ?? '',
    ...(input.durationSeconds !== undefined ? { duration: input.durationSeconds } : {}),
  };
}
