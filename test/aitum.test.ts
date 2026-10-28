/** Aitum "Send Webhook" routes, posting bodies exactly as Aitum would after variable substitution. */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseLenient } from '../src/adapters/shared/webhook-fields.ts';
import { startTestBridge, TestClient } from './helpers.ts';

describe('Aitum trigger routes', () => {
  let bridge: Awaited<ReturnType<typeof startTestBridge>>;
  let client: TestClient;

  before(async () => {
    bridge = await startTestBridge((c) => {
      c.aitum.enabled = true;
      c.aitum.baseUrl = 'http://127.0.0.1:1'; // nothing listening; routes don't need Nexus
      c.broadcaster.twitch = { login: 'teststreamer' };
    });
    client = new TestClient(bridge.port);
    await client.hello();
    await client.request('Subscribe', { events: { Twitch: ['*'], YouTube: ['*'] } });
  });
  after(async () => {
    client.close();
    await bridge.stop();
  });

  async function send(route: string, body: string) {
    const before = client.messages.length;
    const res = await fetch(`http://127.0.0.1:${bridge.port}/ingest/aitum/${route}`, { method: 'POST', body });
    const json = await res.json();
    if (res.status !== 200) return { status: res.status, json };
    const event = await client.waitFor((m) => m.event && client.messages.indexOf(m) >= before);
    return { status: res.status, json, event };
  }

  test('chat message survives quotes that break the JSON', async () => {
    const { event, json } = await send('twitch/chat-message', '{"username": "CoolViewer", "message": "she said "hi" \\o/"}');
    assert.deepEqual(json.emitted, ['Twitch.ChatMessage']);
    assert.equal(event.data.text, 'she said "hi" \\o/');
    assert.equal(event.data.user.name, 'CoolViewer');
    assert.equal(event.data.user.login, 'coolviewer');
    assert.equal(event.data.user.id, 'aitum-coolviewer');
    assert.deepEqual(event.data.parts, [{ type: 'text', text: 'she said "hi" \\o/' }]);
    assert.equal(event.data.meta.firstMessage, false);
  });

  test('subscription uses string tiers; months > 1 becomes ReSub', async () => {
    const sub = await send('twitch/subscription', '{"username": "Subby", "tier": 2, "message": ""}');
    assert.equal(sub.event.event.type, 'Sub');
    assert.equal(sub.event.data.subTier, '2000');

    const resub = await send('twitch/subscription', '{"username": "Subby", "tier": "1", "message": "again", "months": "6"}');
    assert.equal(resub.event.event.type, 'ReSub');
    assert.equal(resub.event.data.cumulativeMonths, 6);
  });

  test('gift subscription: single gift vs bomb', async () => {
    const single = await send('twitch/gift-subscription', '{"gifter": "Santa", "tier": 1, "totalGifts": 1}');
    assert.equal(single.event.event.type, 'GiftSub');
    assert.equal(single.event.data.user.name, 'Santa');

    const bomb = await send('twitch/gift-subscription', '{"gifter": "Santa", "tier": 1, "totalGifts": 10}');
    assert.equal(bomb.event.event.type, 'GiftBomb');
    assert.equal(bomb.event.data.gifts, 10);
  });

  test('cheer, raid, redemption, hype train', async () => {
    const cheer = await send('twitch/bit-cheer', '{"username": "Bitsy", "bits": 100, "message": "Cheer100 nice"}');
    assert.equal(cheer.event.data.bits, 100);

    const raid = await send('twitch/incoming-raid', '{"raidingChannel": "Raider", "viewers": 42}');
    assert.equal(raid.event.data.from_broadcaster_user_name, 'Raider');
    assert.equal(raid.event.data.viewers, 42);
    assert.equal(raid.event.data.to_broadcaster_user_login, 'teststreamer');

    const reward = await send('twitch/channel-point-redemption', '{"redemption": "Hydrate", "username": "u", "cost": 500, "userInput": ""}');
    assert.equal(reward.event.data.reward.title, 'Hydrate');
    assert.equal(reward.event.data.reward.cost, 500);

    const train = await send('twitch/hype-train-progress', '{"level": 2, "progress": 45}');
    assert.deepEqual([train.event.event.type, train.event.data.level, train.event.data.percent], ['HypeTrainUpdate', 2, 45]);
  });

  test('YouTube chat and super chat', async () => {
    const msg = await send(
      'youtube/chat-message-added',
      '{"username": "YTUser", "message": "hello", "isModerator": true, "isMember": "false", "channelId": "UC123"}',
    );
    assert.deepEqual(msg.event.event, { source: 'YouTube', type: 'Message' });
    assert.equal(msg.event.data.message, 'hello');
    assert.equal(msg.event.data.user.id, 'UC123');
    assert.equal(msg.event.data.user.isModerator, true);
    assert.equal(msg.event.data.user.isSponsor, false);
    assert.ok(msg.event.data.eventId);

    const sc = await send('youtube/super-chat', '{"username": "Rich", "amount": "$5.00", "currency": "USD", "comment": "gg"}');
    assert.equal(sc.event.data.amount, '$5.00');
    assert.equal(sc.event.data.message, 'gg');
  });

  test('unknown trigger route is a 400', async () => {
    const res = await send('twitch/not-a-trigger', '{}');
    assert.equal(res.status, 400);
  });
});

test('parseLenient keeps valid JSON as-is and recovers broken values', () => {
  assert.deepEqual(parseLenient('{"a": 1, "b": "x"}', ['a', 'b']), { a: 1, b: 'x' });
  assert.deepEqual(parseLenient('{"username": "A", "message": "a "quoted", thing", "bits": 5}', ['username', 'message', 'bits']), {
    username: 'A',
    message: 'a "quoted", thing',
    bits: '5',
  });
});
