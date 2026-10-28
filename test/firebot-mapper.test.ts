/**
 * Firebot → Streamer.bot mapping. The assertions mirror the fields read by the
 * Nutty multichat overlay (widgets.nutty.gg/multichat-overlay), our reference
 * Streamer.bot client.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FirebotEventMapper } from '../src/adapters/firebot/firebot-mapper.ts';

const channel = { id: '42', login: 'teststreamer', name: 'TestStreamer' };
const newMapper = (emitUnmappedAsCustom = false) => new FirebotEventMapper({ channel: () => channel, emitUnmappedAsCustom });

const chatMeta = {
  username: 'coolviewer',
  userId: '1001',
  userDisplayName: 'CoolViewer',
  messageText: 'hello Kappa',
  chatMessage: {
    id: 'msg-1',
    username: 'coolviewer',
    userId: '1001',
    userDisplayName: 'CoolViewer',
    rawText: 'hello Kappa',
    color: '#FF0000',
    roles: ['sub'],
    isMod: true,
    isSubscriber: true,
    badges: [{ title: '6-Month Subscriber', url: 'https://badge/sub.png' }],
    parts: [
      { type: 'text', text: 'hello ' },
      { type: 'emote', name: 'Kappa', id: '25', url: 'https://emote/25.png' },
    ],
  },
};

describe('FirebotEventMapper', () => {
  test('chat message has the Streamer.bot 1.x fields the overlay reads', () => {
    const [out] = newMapper().map({ sourceId: 'twitch', eventId: 'chat-message', meta: chatMeta });
    assert.equal(out.source, 'Twitch');
    assert.equal(out.type, 'ChatMessage');
    const d: any = out.data;
    assert.equal(d.messageId, 'msg-1');
    assert.equal(d.text, 'hello Kappa');
    assert.deepEqual(d.user.login, 'coolviewer');
    assert.deepEqual(d.user.name, 'CoolViewer');
    assert.equal(d.user.id, '1001');
    assert.equal(d.user.color, '#FF0000');
    assert.equal(d.user.role, 3);
    assert.equal(d.user.subscribed, true);
    assert.deepEqual(d.user.badges, [{ name: 'subscriber', version: '1', imageUrl: 'https://badge/sub.png' }]);
    assert.equal(d.meta.firstMessage, false);
    assert.equal(d.meta.isMe, false);
    assert.equal(d.isReply, false);
    assert.equal(d.isFromSharedChatGuest, false);
    assert.deepEqual(d.parts, [
      { type: 'text', text: 'hello ' },
      { type: 'emote', text: 'Kappa', imageUrl: 'https://emote/25.png', source: 'Twitch', id: '25' },
    ]);
    // legacy 0.2.x shape
    assert.equal(d.message.message, 'hello Kappa');
    assert.equal(d.message.username, 'coolviewer');
    assert.deepEqual(d.message.emotes[0], {
      id: '25', type: 'Twitch', name: 'Kappa', startIndex: 6, endIndex: 10, imageUrl: 'https://emote/25.png',
    });
  });

  test('chat message without parts falls back to a text part', () => {
    const [out] = newMapper().map({ sourceId: 'twitch', eventId: 'chat-message', meta: { username: 'a', messageText: 'plain' } });
    assert.deepEqual((out.data as any).parts, [{ type: 'text', text: 'plain' }]);
  });

  test('cheer chat messages are left to the Cheer event, which reuses recent chat info', () => {
    const mapper = newMapper();
    const cheerChat = { ...chatMeta, chatMessage: { ...chatMeta.chatMessage, rawText: 'Cheer100 gg', isCheer: true, parts: [] } };
    assert.deepEqual(mapper.map({ sourceId: 'twitch', eventId: 'chat-message', meta: cheerChat }), []);

    const [out] = mapper.map({
      sourceId: 'twitch',
      eventId: 'cheer',
      meta: { username: 'coolviewer', userId: '1001', userDisplayName: 'CoolViewer', bits: 100, cheerMessage: 'Cheer100 gg' },
    });
    const d: any = out.data;
    assert.equal(out.type, 'Cheer');
    assert.equal(d.bits, 100);
    assert.equal(d.user.color, '#FF0000');
    assert.equal(d.messageId, 'msg-1');
    assert.deepEqual(d.parts, [
      { type: 'cheer', text: 'Cheer100', bits: 100 },
      { type: 'text', text: ' gg' },
    ]);
  });

  test('follow exposes user and targetUser', () => {
    const [out] = newMapper().map({ sourceId: 'twitch', eventId: 'follow', meta: { username: 'Newbie', userId: '7', userDisplayName: 'Newbie' } });
    const d: any = out.data;
    assert.equal(d.user_login, 'newbie');
    assert.equal(d.targetUser.name, 'Newbie');
    assert.equal(d.targetUser.login, 'newbie');
  });

  test('sub vs resub, with string tiers', () => {
    const mapper = newMapper();
    const [sub] = mapper.map({ sourceId: 'twitch', eventId: 'sub', meta: { username: 'a', subPlan: '2000', totalMonths: 1 } });
    assert.equal(sub.type, 'Sub');
    assert.equal((sub.data as any).subTier, '2000');
    assert.equal((sub.data as any).isPrime, false);

    const [resub] = mapper.map({
      sourceId: 'twitch',
      eventId: 'sub',
      meta: { username: 'a', subPlan: 'Prime', isPrime: true, isResub: true, totalMonths: 5, subMessage: 'yo' },
    });
    const d: any = resub.data;
    assert.equal(resub.type, 'ReSub');
    assert.equal(d.isPrime, true);
    assert.equal(d.cumulativeMonths, 5);
    assert.equal(d.text, 'yo');
  });

  test('gift sub has recipient and cumlativeTotal', () => {
    const [out] = newMapper().map({
      sourceId: 'twitch',
      eventId: 'subs-gifted',
      meta: { gifterUsername: 'Santa', gifteeUsername: 'Kid', subPlan: '1000', lifetimeGiftCount: 12 },
    });
    const d: any = out.data;
    assert.equal(out.type, 'GiftSub');
    assert.equal(d.user.name, 'Santa');
    assert.equal(d.recipient.name, 'Kid');
    assert.equal(d.subTier, '1000');
    assert.equal(d.cumlativeTotal, 12);
  });

  test('raid, reward redemption, moderation', () => {
    const mapper = newMapper();
    const [raid] = mapper.map({ sourceId: 'twitch', eventId: 'raid', meta: { username: 'raider', userDisplayName: 'Raider', viewerCount: 50 } });
    assert.equal((raid.data as any).from_broadcaster_user_login, 'raider');
    assert.equal((raid.data as any).to_broadcaster_user_login, 'teststreamer');
    assert.equal((raid.data as any).viewers, 50);

    const [reward] = mapper.map({
      sourceId: 'twitch',
      eventId: 'channel-reward-redemption',
      meta: { username: 'u', rewardName: 'Hydrate', rewardCost: 500, messageText: 'drink', rewardId: 'r1' },
    });
    const r: any = reward.data;
    assert.equal(r.reward.title, 'Hydrate');
    assert.equal(r.reward.cost, 500);
    assert.equal(r.user_input, 'drink');
    assert.equal(r.user_login, 'u');

    const [ban] = mapper.map({ sourceId: 'twitch', eventId: 'banned', meta: { username: 'troll', userId: '666' } });
    assert.equal(ban.type, 'UserBanned');
    assert.equal((ban.data as any).targetUser.id, '666');

    const [deleted] = mapper.map({ sourceId: 'twitch', eventId: 'chat-message-deleted', meta: { username: 'u', messageId: 'm9' } });
    assert.equal((deleted.data as any).messageId, 'm9');
  });

  test('donations map to the overlay fields', () => {
    const mapper = newMapper();
    const [sl] = mapper.map({
      sourceId: 'streamlabs',
      eventId: 'donation',
      meta: { from: 'Donor', donationAmount: 5, formattedDonationAmount: '$5.00', donationMessage: 'hi' },
    });
    assert.deepEqual([sl.source, sl.type], ['Streamlabs', 'Donation']);
    assert.equal((sl.data as any).formattedAmount, '$5.00');
    assert.equal((sl.data as any).from, 'Donor');

    const [se] = mapper.map({ sourceId: 'streamelements', eventId: 'donation', meta: { from: 'Donor', donationAmount: 3 } });
    assert.deepEqual([se.source, se.type], ['StreamElements', 'Tip']);
    assert.equal((se.data as any).username, 'Donor');
    assert.equal((se.data as any).amount, 3);
  });

  test('Kick chat (from the Firebot Kick script) has the fields the overlay reads', () => {
    const meta = {
      platform: 'kick',
      username: 'kickfan',
      userId: 777,
      userDisplayName: 'KickFan',
      profilePicture: 'https://kick/avatar.webp',
      messageText: 'hi KEKW',
      messageId: 'k-1',
      badges: [
        { type: 'moderator', text: 'Moderator' },
        { type: 'subscriber', text: 'Subscriber', count: 6 },
      ],
      isReply: true,
      replyToMessageId: 'k-0',
      replyToMessage: 'first!',
      replyToUsername: 'Someone',
      chatMessage: {
        id: 'k-1',
        userId: 'kick-777',
        username: 'kickfan',
        rawText: 'hi KEKW',
        color: '#53FC18',
        roles: ['mod', 'sub'],
        badges: [
          { title: 'Moderator', url: 'data:image/svg+xml,drawn' },
          { title: 'level', url: 'https://ext.cdn.kick.com/badges/level.png' },
        ],
        parts: [
          { type: 'text', text: 'hi ' },
          { type: 'third-party-emote', name: 'KEKW', origin: 'Kick', url: 'https://files.kick.com/emotes/1/fullsize' },
        ],
      },
    };
    const [out] = newMapper().map({ sourceId: 'rustyy-kick', eventId: 'chat-message', meta });
    assert.equal(out.source, 'Kick');
    assert.equal(out.type, 'ChatMessage');
    const d: any = out.data;
    assert.equal(d.messageId, 'k-1');
    assert.equal(d.text, 'hi KEKW');
    assert.equal(d.user.id, '777');
    assert.equal(d.user.login, 'kickfan');
    assert.equal(d.user.name, 'KickFan');
    assert.equal(d.user.color, '#53FC18');
    assert.equal(d.user.role, 3);
    assert.equal(d.user.subscribed, true);
    // Kick's own badge ids, with images only where Kick gave one (Nutty draws the rest).
    assert.deepEqual(
      d.user.badges.map((b: any) => [b.id, b.count ?? null, b.imageUrl]),
      [['moderator', null, ''], ['subscriber', 6, ''], ['level', null, 'https://ext.cdn.kick.com/badges/level.png']],
    );
    assert.deepEqual(d.parts, [
      { type: 'text', text: 'hi ' },
      { type: 'emote', text: 'KEKW', imageUrl: 'https://files.kick.com/emotes/1/fullsize', source: 'Kick' },
    ]);
    assert.equal(d.isReply, true);
    assert.equal(d.reply.userName, 'Someone');
    assert.equal(d.reply.msgBody, 'first!');
  });

  test('Kick follow, subs and gifts', () => {
    const [follow] = newMapper().map({ sourceId: 'rustyy-kick', eventId: 'follow', meta: { username: 'newbie', userId: 5, userDisplayName: 'Newbie' } });
    assert.equal(follow.source, 'Kick');
    assert.equal(follow.type, 'Follow');
    assert.equal((follow.data as any).user.name, 'Newbie');
    assert.equal((follow.data as any).user.id, '5');
    const [resub] = newMapper().map({ sourceId: 'rustyy-kick', eventId: 'sub', meta: { username: 'loyal', userId: 8, totalMonths: 6, isResub: true } });
    assert.equal(resub.type, 'Resubscription');
    assert.equal((resub.data as any).months, 6);
    const [bomb] = newMapper().map({
      sourceId: 'rustyy-kick',
      eventId: 'community-subs-gifted',
      meta: { username: 'generous', userId: 3, gifterUsername: 'generous', subCount: 2, giftReceivers: [{ gifteeUsername: 'a' }, { gifteeUsername: 'b' }] },
    });
    assert.equal(bomb.type, 'MassGiftSubscription');
    assert.deepEqual((bomb.data as any).recipients.map((r: any) => r.name), ['a', 'b']);
  });

  test('unmapped events are dropped unless emitUnmappedAsCustom is on', () => {
    const event = { sourceId: 'firebot', eventId: 'something-new', meta: { x: 1 } };
    assert.deepEqual(newMapper().map(event), []);
    const [out] = newMapper(true).map(event);
    assert.deepEqual([out.source, out.type], ['General', 'Custom']);
  });
});
