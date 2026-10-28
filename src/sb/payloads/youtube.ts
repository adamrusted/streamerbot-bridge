/** Builders for Streamer.bot YouTube event payloads (fields as read by current widgets). */
import { randomUUID } from 'node:crypto';
import type { JsonObject } from '../../core/types.ts';
import { textParts } from './twitch.ts';

export interface YouTubeUser {
  id: string;
  name: string;
  profileImageUrl?: string;
  channelUrl?: string;
  isOwner?: boolean;
  isModerator?: boolean;
  isSponsor?: boolean;
  isVerified?: boolean;
}

export function youtubeUser(user: YouTubeUser): JsonObject {
  return {
    id: user.id,
    name: user.name,
    profileImageUrl: user.profileImageUrl ?? '',
    channelUrl: user.channelUrl ?? (user.id ? `https://www.youtube.com/channel/${user.id}` : ''),
    isOwner: user.isOwner ?? false,
    isModerator: user.isModerator ?? false,
    isSponsor: user.isSponsor ?? false,
    isVerified: user.isVerified ?? false,
  };
}

const base = (user: YouTubeUser) => ({
  eventId: randomUUID(),
  publishedAt: new Date().toISOString(),
  user: youtubeUser(user),
});

export function message(user: YouTubeUser, text: string): JsonObject {
  return { ...base(user), message: text, parts: textParts(text), emotes: [] };
}

export function superChat(input: {
  user: YouTubeUser;
  amount: string;
  microAmount?: number;
  currencyCode?: string;
  message?: string;
  tier?: number;
}): JsonObject {
  return {
    ...base(input.user),
    amount: input.amount,
    microAmount: input.microAmount ?? 0,
    currencyCode: input.currencyCode ?? '',
    message: input.message ?? '',
    tier: input.tier ?? 1,
  };
}

export function newSponsor(user: YouTubeUser, levelName: string, isUpgrade = false): JsonObject {
  return { ...base(user), levelName, isUpgrade };
}

export function memberMilestone(user: YouTubeUser, input: { months: number; levelName?: string; message?: string }): JsonObject {
  return { ...base(user), months: input.months, levelName: input.levelName ?? '', message: input.message ?? '' };
}
