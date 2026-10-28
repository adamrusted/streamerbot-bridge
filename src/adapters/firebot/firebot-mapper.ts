/**
 * Translates Firebot events (as forwarded by integrations/firebot/sb-bridge.js)
 * into Streamer.bot events.
 *
 * Firebot's event metadata is not formally documented; field names here come
 * from Firebot's event sources and are read defensively with fallbacks. Run the
 * bridge with logLevel "debug" to see the raw metadata of every event.
 */
import { randomUUID } from 'node:crypto';
import type { JsonObject, SbEventOut } from '../../core/types.ts';
import * as kick from '../../sb/payloads/kick.ts';
import * as tw from '../../sb/payloads/twitch.ts';

export interface FirebotEvent {
  sourceId: string;
  eventId: string;
  meta?: JsonObject;
  isManual?: boolean;
  isSimulation?: boolean;
}

type Meta = Record<string, any>;

const str = (...values: unknown[]): string => {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return String(v);
  return '';
};
const num = (...values: unknown[]): number => {
  for (const v of values) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(n)) return n;
  }
  return 0;
};

/** A user from the common Firebot meta fields (username/userId/userDisplayName), optionally prefixed. */
function userFrom(meta: Meta, prefix = ''): tw.TwitchUser {
  const key = (k: string) => (prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k);
  const login = str(meta[key('username')], meta[key('userName')]).toLowerCase();
  return {
    id: str(meta[key('userId')]),
    login,
    name: str(meta[key('userDisplayName')], meta[key('displayName')], meta[key('username')]),
  };
}

function roleOf(cm: Meta, roles: string[]): number {
  if (cm.isBroadcaster || roles.includes('broadcaster')) return tw.ROLE.broadcaster;
  if (cm.isMod || roles.includes('mod') || roles.includes('moderator')) return tw.ROLE.moderator;
  if (cm.isVip || roles.includes('vip')) return tw.ROLE.vip;
  return tw.ROLE.viewer;
}

function badgeName(title: string): string {
  const t = title.toLowerCase();
  for (const known of ['subscriber', 'moderator', 'broadcaster', 'founder', 'vip', 'verified', 'staff', 'partner']) {
    if (t.includes(known)) return known;
  }
  if (t.includes('bits')) return 'bits';
  return t.replace(/\s+/g, '-');
}

function mapBadges(badges: unknown): tw.SbBadge[] {
  if (!Array.isArray(badges)) return [];
  return badges.map((b: Meta) => ({
    name: badgeName(str(b.name, b.title, b.setId)),
    version: str(b.version, b.id, '1'),
    imageUrl: str(b.url, b.imageUrl, b.image),
  }));
}

/** Firebot parsed message parts → Streamer.bot parts. Unknown part types degrade to text. */
function mapParts(parts: unknown): tw.SbMessagePart[] {
  if (!Array.isArray(parts)) return [];
  return parts.map((p: Meta): tw.SbMessagePart => {
    switch (p.type) {
      case 'emote':
        return { type: 'emote', text: str(p.name, p.text), imageUrl: str(p.animatedUrl, p.url), source: 'Twitch', id: str(p.id) };
      case 'third-party-emote':
        return { type: 'emote', text: str(p.name, p.text), imageUrl: str(p.animatedUrl, p.url), source: str(p.origin, 'ThirdParty') };
      case 'cheer':
        return { type: 'cheer', text: str(p.text, p.name, `${str(p.prefix, 'Cheer')}${num(p.amount, p.bits)}`), bits: num(p.amount, p.bits), imageUrl: str(p.url) || undefined };
      case 'mention':
        return { type: 'mention', text: str(p.text, p.name) };
      default:
        return { type: 'text', text: str(p.text, p.name, p.url) };
    }
  });
}

/**
 * A Kick user from the Firebot Kick script's metadata (Firebot-Scripts' src/kick, event source
 * `rustyy-kick`). `badges` there are Kick's own ({type, text, count}); images Kick did give
 * (e.g. chat level, from the chat message's http badge urls) are added after them.
 */
function kickUserFrom(meta: Meta, prefix = ''): kick.KickUser {
  const user = userFrom(meta, prefix);
  const cm: Meta = prefix ? {} : (meta.chatMessage ?? {});
  const raw: Meta[] = prefix ? [] : Array.isArray(meta.badges) ? meta.badges : [];
  const badges: kick.KickBadge[] = raw.map((b) => ({ id: str(b.type), type: str(b.type), name: str(b.text, b.type), count: b.count ?? undefined, imageUrl: '' }));
  const roleTitles = new Set(raw.map((b) => str(b.text).toLowerCase()));
  for (const b of Array.isArray(cm.badges) ? (cm.badges as Meta[]) : []) {
    const url = str(b.url);
    const title = str(b.title);
    if (url.startsWith('http') && !roleTitles.has(title.toLowerCase())) badges.push({ id: title, type: title, name: title, imageUrl: url });
  }
  return {
    // The script prefixes Kick ids in chat messages ("kick-123"); the event's userId is the plain one.
    id: str(meta[prefix ? `${prefix}UserId` : 'userId']),
    login: user.login,
    name: user.name,
    color: str(cm.color, meta.color),
    profileImageUrl: str(prefix ? '' : meta.profilePicture, cm.profilePicUrl),
    badges,
    isVerified: Boolean(meta.isVerified),
  };
}

const RECENT_CHAT_MS = 15_000;

export class FirebotEventMapper {
  #channel: () => tw.Channel;
  #emitUnmapped: boolean;
  /** Recent chat per user, used to enrich cheers (Firebot's cheer meta lacks badges/color). */
  #recentChat = new Map<string, { at: number; input: tw.ChatMessageInput }>();

  constructor(options: { channel: () => tw.Channel; emitUnmappedAsCustom: boolean }) {
    this.#channel = options.channel;
    this.#emitUnmapped = options.emitUnmappedAsCustom;
  }

  map(event: FirebotEvent): SbEventOut[] {
    const meta: Meta = event.meta ?? {};
    const key = `${event.sourceId}:${event.eventId}`;
    const out = this.#map(key, meta);
    if (out) return out;
    if (!this.#emitUnmapped) return [];
    return [{ source: 'General', type: 'Custom', data: { bridge: 'firebot', ...event } }];
  }

  #chatInput(meta: Meta): tw.ChatMessageInput {
    const cm: Meta = meta.chatMessage ?? {};
    const roles: string[] = [...(cm.roles ?? []), ...(meta.twitchUserRoles ?? [])].map((r: unknown) => String(r).toLowerCase());
    const text = str(cm.rawText, cm.text, meta.messageText);
    const parts = mapParts(cm.parts);
    const user: tw.TwitchUser = {
      id: str(cm.userId, meta.userId),
      login: str(cm.username, meta.username).toLowerCase(),
      name: str(cm.userDisplayName, meta.userDisplayName, cm.username, meta.username),
      color: str(cm.color),
      role: roleOf(cm, roles),
      subscribed: Boolean(cm.isSubscriber || cm.isFounder || roles.some((r) => r === 'sub' || r === 'founder' || r.startsWith('tier'))),
      badges: mapBadges(cm.badges),
    };
    return {
      messageId: str(cm.id, meta.messageId) || randomUUID(),
      text,
      parts: parts.length ? parts : tw.partsFromText(text),
      user,
      channel: this.#channel(),
      firstMessage: Boolean(cm.isFirstChat ?? meta.isFirstChat),
      isMe: Boolean(cm.action ?? cm.isAction),
      isHighlighted: Boolean(cm.isHighlighted),
      isCustomReward: Boolean(cm.customRewardId),
      bits: num(cm.bits),
      reply: cm.isReply
        ? {
            msgId: str(cm.replyParentMessageId),
            userId: str(cm.replyParentMessageSenderUserId),
            userLogin: str(cm.replyParentMessageSenderUsername, cm.replyParentMessageSenderDisplayName).toLowerCase(),
            userName: str(cm.replyParentMessageSenderDisplayName, cm.replyParentMessageSenderUsername),
            msgBody: str(cm.replyParentMessageText),
          }
        : undefined,
      sharedChatSource: cm.isSharedChatMessage
        ? {
            id: str(cm.sharedChatRoomId),
            login: str(cm.sharedChatRoomUsername).toLowerCase(),
            name: str(cm.sharedChatRoomDisplayName, cm.sharedChatRoomUsername),
          }
        : undefined,
    };
  }

  #rememberChat(input: tw.ChatMessageInput): void {
    const now = Date.now();
    for (const [k, v] of this.#recentChat) if (now - v.at > RECENT_CHAT_MS) this.#recentChat.delete(k);
    this.#recentChat.set(input.user.id || input.user.login, { at: now, input });
  }

  #recentUser(user: tw.TwitchUser): tw.TwitchUser {
    const hit = this.#recentChat.get(user.id) ?? this.#recentChat.get(user.login);
    return hit && Date.now() - hit.at <= RECENT_CHAT_MS ? { ...hit.input.user, ...stripEmpty(user) } : user;
  }

  #map(key: string, m: Meta): SbEventOut[] | undefined {
    const twitch = (type: string, data: unknown): SbEventOut[] => [{ source: 'Twitch', type, data }];

    switch (key) {
      case 'twitch:chat-message': {
        const input = this.#chatInput(m);
        const cm: Meta = m.chatMessage ?? {};
        this.#rememberChat(input);
        if (cm.whisper) return twitch('Whisper', { ...tw.chatMessage(input), recipient: this.#channel() });
        // Cheer messages are delivered via twitch:cheer, like Streamer.bot's Cheer event.
        if (cm.isCheer || (input.bits ?? 0) > 0) return [];
        if (cm.isAnnouncement) return twitch('Announcement', tw.announcement({ ...input, color: cm.announcementColor }));
        return twitch('ChatMessage', tw.chatMessage(input));
      }
      case 'twitch:first-time-chat': {
        const input = this.#chatInput(m);
        return twitch('FirstWord', { ...tw.chatMessage({ ...input, firstMessage: true }) });
      }
      case 'twitch:cheer': {
        const user = this.#recentUser(userFrom(m));
        const text = str(m.cheerMessage, m.messageText);
        const bits = num(m.bits);
        const recent = this.#recentChat.get(user.id) ?? this.#recentChat.get(user.login);
        const parts = recent && recent.input.text === text ? recent.input.parts : tw.partsFromText(text);
        return twitch(
          'Cheer',
          tw.cheer({
            messageId: recent?.input.messageId ?? randomUUID(),
            text,
            parts,
            user,
            channel: this.#channel(),
            bits,
            isAnonymous: Boolean(m.isAnonymous),
          }),
        );
      }
      case 'twitch:follow':
        return twitch('Follow', tw.follow(userFrom(m)));
      case 'twitch:sub': {
        const user = this.#recentUser(userFrom(m));
        const plan = m.isPrime ? 'Prime' : m.subPlan;
        const text = str(m.subMessage, m.messageText);
        const months = num(m.totalMonths, m.cumulativeMonths, 1);
        if (m.isResub || months > 1) {
          return twitch('ReSub', tw.reSub(user, plan, { cumulative: months, streak: num(m.streak) }, text));
        }
        return twitch('Sub', tw.sub(user, plan, text));
      }
      case 'twitch:subs-gifted': {
        const gifter = m.gifterUsername ? userFrom(m, 'gifter') : userFrom(m);
        return twitch(
          'GiftSub',
          tw.giftSub({
            gifter: this.#recentUser(gifter),
            recipient: userFrom(m, 'giftee'),
            plan: m.subPlan,
            monthsGifted: num(m.giftDuration, 1),
            totalGifted: num(m.lifetimeGiftCount),
            isAnonymous: Boolean(m.isAnonymous),
          }),
        );
      }
      case 'twitch:community-subs-gifted': {
        const gifter = m.gifterUsername ? userFrom(m, 'gifter') : userFrom(m);
        const receivers: Meta[] = Array.isArray(m.giftReceivers) ? m.giftReceivers : [];
        return twitch(
          'GiftBomb',
          tw.giftBomb({
            gifter,
            count: num(m.subCount, receivers.length),
            plan: m.subPlan,
            recipients: receivers.map((r) => userFrom(r, 'giftee')),
            totalGifted: num(m.lifetimeGiftCount),
            isAnonymous: Boolean(m.isAnonymous),
          }),
        );
      }
      case 'twitch:raid':
        return twitch('Raid', tw.raid(userFrom(m), num(m.viewerCount, m.viewers), this.#channel()));
      case 'twitch:channel-reward-redemption':
        return twitch(
          'RewardRedemption',
          tw.rewardRedemption({
            redemptionId: str(m.redemptionId) || randomUUID(),
            user: userFrom(m),
            reward: {
              id: str(m.rewardId),
              title: str(m.rewardName),
              cost: num(m.rewardCost),
              prompt: str(m.rewardDescription),
            },
            userInput: str(m.messageText),
          }),
        );
      case 'twitch:stream-online':
        return twitch('StreamOnline', { broadcaster: this.#channel() });
      case 'twitch:stream-offline':
        return twitch('StreamOffline', { broadcaster: this.#channel() });
      case 'twitch:chat-message-deleted':
        return twitch('ChatMessageDeleted', tw.chatMessageDeleted({ messageId: str(m.messageId), text: str(m.messageText), user: userFrom(m) }));
      case 'twitch:banned':
        return twitch('UserBanned', tw.moderation({ target: userFrom(m), moderator: str(m.moderator), reason: str(m.modReason) }));
      case 'twitch:timeout':
        return twitch(
          'UserTimedOut',
          tw.moderation({ target: userFrom(m), moderator: str(m.moderator), reason: str(m.modReason), durationSeconds: num(m.timeoutDuration) }),
        );
      case 'twitch:unbanned':
        return twitch('UserUnbanned', tw.moderation({ target: userFrom(m), moderator: str(m.moderator) }));
      case 'twitch:chat-cleared':
        return twitch('ChatCleared', { moderator: str(m.username) });
      case 'twitch:whisper':
        return twitch('Whisper', { user: tw.userObject(userFrom(m)), message: str(m.message, m.messageText), text: str(m.message, m.messageText) });
      case 'twitch:shoutout-received':
        return twitch('ShoutoutReceived', { user: tw.userObject(userFrom(m)), viewerCount: num(m.viewerCount) });
      case 'twitch:hype-train-start':
        return twitch('HypeTrainStart', { ...m });
      case 'twitch:hype-train-progress':
        return twitch('HypeTrainUpdate', { ...m });
      case 'twitch:hype-train-level-up':
        return twitch('HypeTrainLevelUp', { ...m });
      case 'twitch:hype-train-end':
        return twitch('HypeTrainEnd', { ...m });
      case 'twitch:ad-break-start':
        return twitch('AdRun', { length_seconds: num(m.adBreakDuration), is_automatic: !m.isAdBreakScheduled, ...m });
      case 'twitch:category-changed':
      case 'twitch:title-changed':
        return twitch('StreamUpdate', { title: str(m.title), gameName: str(m.category, m.categoryName), ...m });
      case 'twitch:poll-begin':
        return twitch('PollCreated', { ...m });
      case 'twitch:poll-progress':
        return twitch('PollUpdated', { ...m });
      case 'twitch:poll-end':
        return twitch('PollCompleted', { ...m });
      case 'twitch:prediction-begin':
        return twitch('PredictionCreated', { ...m });
      case 'twitch:prediction-progress':
        return twitch('PredictionUpdated', { ...m });
      case 'twitch:prediction-lock':
        return twitch('PredictionLocked', { ...m });
      case 'twitch:prediction-end':
        return twitch('PredictionCompleted', { ...m });
      case 'twitch:bits-badge-unlocked':
        return twitch('BitsBadgeTier', { user: tw.userObject(userFrom(m)), tier: num(m.badgeTier), message: str(m.message) });
      case 'twitch:charity-donation':
        return twitch('CharityDonation', { user: tw.userObject(userFrom(m)), ...m });

      // The Firebot Kick script (Firebot-Scripts' src/kick); its metadata uses Twitch's field names.
      case 'rustyy-kick:chat-message':
      case 'rustyy-kick:first-time-chat': {
        const cm: Meta = m.chatMessage ?? {};
        const text = str(cm.rawText, m.messageText);
        const parts = mapParts(cm.parts);
        const data = kick.chatMessage({
          messageId: str(cm.id, m.messageId) || randomUUID(),
          text,
          parts: parts.length ? parts : undefined,
          user: kickUserFrom(m),
          firstMessage: key.endsWith('first-time-chat'),
          reply: m.isReply
            ? {
                msgId: str(m.replyToMessageId),
                userId: '',
                userLogin: str(m.replyToUsername).toLowerCase(),
                userName: str(m.replyToUsername),
                msgBody: str(m.replyToMessage),
              }
            : undefined,
        });
        return [{ source: 'Kick', type: key.endsWith('first-time-chat') ? 'FirstWords' : 'ChatMessage', data }];
      }
      case 'rustyy-kick:follow':
        return [{ source: 'Kick', type: 'Follow', data: kick.follow(kickUserFrom(m)) }];
      case 'rustyy-kick:sub':
        return [{
          source: 'Kick',
          type: m.isResub ? 'Resubscription' : 'Subscription',
          data: kick.subscription(kickUserFrom(m), num(m.totalMonths, m.months, 1), Boolean(m.isResub)),
        }];
      case 'rustyy-kick:subs-gifted':
        return [{
          source: 'Kick',
          type: 'GiftSubscription',
          data: kick.giftSubscription(kickUserFrom(m), { id: str(m.gifteeUserId), login: str(m.gifteeUsername).toLowerCase(), name: str(m.gifteeUsername) }, Boolean(m.isAnonymous)),
        }];
      case 'rustyy-kick:community-subs-gifted': {
        const receivers: Meta[] = Array.isArray(m.giftReceivers) ? m.giftReceivers : [];
        return [{
          source: 'Kick',
          type: 'MassGiftSubscription',
          data: kick.massGiftSubscription(
            kickUserFrom(m),
            receivers.map((r) => ({ id: str(r.gifteeUserId), login: str(r.gifteeUsername).toLowerCase(), name: str(r.gifteeUsername) })),
            Boolean(m.isAnonymous),
          ),
        }];
      }
      case 'rustyy-kick:banned':
        return [{ source: 'Kick', type: 'UserBanned', data: kick.moderation({ target: kickUserFrom(m), moderator: str(m.moderator), reason: str(m.modReason) }) }];
      case 'rustyy-kick:timeout':
        return [{
          source: 'Kick',
          type: 'UserTimedOut',
          data: kick.moderation({ target: kickUserFrom(m), moderator: str(m.moderator), reason: str(m.modReason), durationSeconds: num(m.timeoutDuration) }),
        }];
      case 'rustyy-kick:stream-online':
        return [{ source: 'Kick', type: 'StreamOnline', data: { title: str(m.title), startedAt: str(m.startedAt) } }];
      case 'rustyy-kick:stream-offline':
        return [{ source: 'Kick', type: 'StreamOffline', data: { title: str(m.title), endedAt: str(m.endedAt) } }];
      case 'rustyy-kick:channel-updated':
        return [{
          source: 'Kick',
          type: 'ChannelUpdate',
          data: { title: str(m.title), category: str(m.category), categoryId: str(m.categoryId), language: str(m.language), isMature: Boolean(m.isMature) },
        }];

      case 'streamlabs:donation':
        return [{
          source: 'Streamlabs',
          type: 'Donation',
          data: {
            id: str(m.id) || randomUUID(),
            from: str(m.from, m.username),
            amount: num(m.donationAmount, m.amount),
            formattedAmount: str(m.formattedDonationAmount, m.donationAmount),
            currency: str(m.currency, 'USD'),
            message: str(m.donationMessage, m.message),
            isTest: false,
          },
        }];
      case 'streamelements:donation':
        return [{
          source: 'StreamElements',
          type: 'Tip',
          data: {
            id: str(m.id) || randomUUID(),
            username: str(m.from, m.username),
            amount: num(m.donationAmount, m.amount),
            currency: str(m.currency, 'USD'),
            message: str(m.donationMessage, m.message),
            isTest: false,
          },
        }];
      case 'tipeeestream:donation':
        return [{
          source: 'TipeeeStream',
          type: 'Donation',
          data: {
            username: str(m.from, m.username),
            amount: num(m.donationAmount, m.amount),
            currency: str(m.currency, 'USD'),
            message: str(m.donationMessage, m.message),
          },
        }];
      case 'extralife:donation':
        return [{
          source: 'DonorDrive',
          type: 'Donation',
          data: {
            donorName: str(m.from, m.username),
            amount: num(m.donationAmount, m.amount),
            message: str(m.donationMessage, m.message),
          },
        }];

      case 'firebot:custom-variable-set':
        return [{
          source: 'Misc',
          type: 'GlobalVariableUpdated',
          data: { name: str(m.createdCustomVariableName, m.name), newValue: m.createdCustomVariableData ?? m.value, persisted: false },
        }];

      case 'obs:scene-changed':
        return [{ source: 'Obs', type: 'SceneChanged', data: { scene: { sceneName: str(m.sceneName) }, sceneName: str(m.sceneName) } }];
      case 'obs:stream-started':
        return [{ source: 'Obs', type: 'StreamingStarted', data: {} }];
      case 'obs:stream-stopped':
        return [{ source: 'Obs', type: 'StreamingStopped', data: {} }];
      case 'obs:recording-started':
        return [{ source: 'Obs', type: 'RecordingStarted', data: {} }];
      case 'obs:recording-stopped':
        return [{ source: 'Obs', type: 'RecordingStopped', data: {} }];
    }
    return undefined;
  }
}

function stripEmpty<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
}
