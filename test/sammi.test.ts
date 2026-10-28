/** SAMMI: stringified trigger objects in, local API (webhook/triggerButton/getVariable) out. */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ingest, startFakeApi, startTestBridge, TestClient } from './helpers.ts';

describe('SAMMI', () => {
  let bridge: Awaited<ReturnType<typeof startTestBridge>>;
  let client: TestClient;
  let api: Awaited<ReturnType<typeof startFakeApi>>;

  before(async () => {
    api = await startFakeApi({
      'GET /api?request=getVariable&name=Architecture': { data: 'x64' },
      'GET /api?request=getVariable&name=score': { data: 42 },
      'POST /webhook': { data: 'Ok.' },
      'POST /api': { data: 'Ok.' },
    });
    bridge = await startTestBridge((c) => {
      c.sammi.enabled = true;
      c.sammi.baseUrl = api.url;
      c.sammi.password = 'pw';
      c.sammi.actions = ['Confetti', { name: 'Scene Swap', buttonId: 'ID19' }];
      c.sammi.globals = ['score'];
      c.broadcaster.twitch = { login: 'teststreamer' };
    });
    client = new TestClient(bridge.port);
    await client.hello();
    await client.request('Subscribe', { events: { Twitch: ['*'], YouTube: ['*'], General: ['Custom'] } });
  });
  after(async () => {
    client.close();
    await bridge.stop();
    await api.close();
  });

  const send = (type: number, body: unknown) => ingest(bridge.port, client, `sammi/event/${type}`, JSON.stringify(body));

  test('chat message: snake_case keys, emotes from the emote list, roles from flags', async () => {
    const { events } = await send(0, {
      user_name: 'coolviewer',
      display_name: 'CoolViewer',
      user_id: '1001',
      message: 'hi Kappa there',
      message_id: 'm-1',
      emote_list: '25:3-7',
      name_color: '#00FF00',
      is_vip: 1,
      is_subscriber: 0,
    });
    const d = events[0].data;
    assert.deepEqual(events[0].event, { source: 'Twitch', type: 'ChatMessage' });
    assert.deepEqual([d.messageId, d.user.id, d.user.name, d.user.color, d.user.role], ['m-1', '1001', 'CoolViewer', '#00FF00', 2]);
    assert.deepEqual(d.parts, [
      { type: 'text', text: 'hi ' },
      { type: 'emote', text: 'Kappa', imageUrl: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', source: 'Twitch', id: '25' },
      { type: 'text', text: ' there' },
    ]);
  });

  test('display-label keys work too ("User Name")', async () => {
    const { events } = await send(6, { 'User Name': 'newbie', 'Display Name': 'Newbie', 'User ID': '9' });
    assert.deepEqual([events[0].event.type, events[0].data.targetUser.name, events[0].data.user_id], ['Follow', 'Newbie', '9']);
  });

  test('subscriber trigger: sub / resub / gift by context', async () => {
    const sub = await send(1, { user_name: 'a', tier: 'Tier 3', context: 'sub' });
    assert.deepEqual([sub.events[0].event.type, sub.events[0].data.subTier], ['Sub', '3000']);

    const resub = await send(1, { user_name: 'a', tier: 'Prime', context: 'resub', month: 9, message: 'hey' });
    assert.deepEqual([resub.events[0].event.type, resub.events[0].data.isPrime, resub.events[0].data.cumulativeMonths], ['ReSub', true, 9]);

    const gift = await send(1, { user_name: 'santa', gifted_display_name: 'Kid', gifted_user_name: 'kid', tier: 'Tier 1', context: 'anonsubgift' });
    assert.deepEqual([gift.events[0].event.type, gift.events[0].data.recipient.name, gift.events[0].data.isAnonymous], ['GiftSub', 'Kid', true]);
  });

  test('moderation: ban, timeout, delete', async () => {
    const ban = await send(11, { event: 'ban', target_user_login: 'troll', target_user_id: '666' });
    assert.deepEqual([ban.events[0].event.type, ban.events[0].data.targetUser.id], ['UserBanned', '666']);

    const timeout = await send(11, { event: 'timeout', target_user_login: 'loud', expires_at: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(timeout.events[0].event.type, 'UserTimedOut');
    assert.ok(timeout.events[0].data.duration > 55);

    const del = await send(11, { event: 'delete', target_user_login: 'x', message_id: 'm-9' });
    assert.deepEqual([del.events[0].event.type, del.events[0].data.messageId], ['ChatMessageDeleted', 'm-9']);
  });

  test('hype train progress with a higher level also emits HypeTrainLevelUp', async () => {
    await send(17, { event: 'begin', level: 1, progress: 100, goal: 1000 });
    const up = await send(17, { event: 'progress', level: 2, progress: 250, goal: 1000 });
    assert.deepEqual(up.json.emitted, ['Twitch.HypeTrainUpdate', 'Twitch.HypeTrainLevelUp']);
    assert.equal(up.events[0].data.percent, 25);
  });

  test('YouTube super chat and unmapped triggers as General.Custom', async () => {
    const sc = await send(20, { display_name: 'Rich', amount: 5_000_000, amount_as_string: '$5.00', currency: 'USD', message: 'gg' });
    assert.deepEqual([sc.events[0].event.type, sc.events[0].data.amount, sc.events[0].data.microAmount], ['SuperChat', '$5.00', 5_000_000]);

    const hotkey = await send(7, { key: 'F1' });
    assert.deepEqual(hotkey.events[0].event, { source: 'General', type: 'Custom' });
    assert.deepEqual([hotkey.events[0].data.triggerType, hotkey.events[0].data.key], [7, 'F1']);
  });

  test('configured actions fire webhooks (with args) or buttons; password is sent', async () => {
    const list = await client.request('GetActions');
    assert.deepEqual(list.actions.map((a: any) => a.name), ['Confetti', 'Scene Swap']);

    await client.request('DoAction', { action: { name: 'Confetti' }, args: { amount: 50 } });
    const hook = api.requests.find((r) => r.url === '/webhook');
    assert.deepEqual(hook?.body, { amount: 50, trigger: 'Confetti' });
    assert.equal(hook?.headers.authorization, 'pw');

    await client.request('DoAction', { action: { name: 'Scene Swap' } });
    assert.deepEqual(api.requests.find((r) => r.url === '/api' && r.method === 'POST')?.body, { request: 'triggerButton', buttonID: 'ID19' });
  });

  test('globals: configured names listed, any name readable via GetGlobal', async () => {
    const globals = await client.request('GetGlobals');
    assert.equal(globals.variables.score.value, 42);
    assert.equal((await client.request('GetGlobal', { variable: 'Architecture' })).variable.value, 'x64');
    assert.equal((await client.request('GetGlobal', { variable: 'missing' })).status, 'error');
  });
});
