/** Mix It Up: Web Request routes (bodies as Mix It Up sends them) and Developer API calls. */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ingest, startFakeApi, startTestBridge, TestClient } from './helpers.ts';

describe('Mix It Up', () => {
  let bridge: Awaited<ReturnType<typeof startTestBridge>>;
  let client: TestClient;
  let api: Awaited<ReturnType<typeof startFakeApi>>;

  before(async () => {
    api = await startFakeApi({
      'GET /api/v2/status/version': '1.2.3.4',
      'GET /api/v2/commands*': {
        TotalCount: 2,
        Commands: [
          { ID: 'c1', Name: 'Lurk', Type: 'Chat', IsEnabled: true },
          { ID: 'c2', Name: 'Hype', Type: 'Custom', IsEnabled: false, GroupName: 'Alerts' },
        ],
      },
      'POST /api/v2/commands/c2': null,
      'POST /api/v2/chat/message': null,
      'GET /api/v2/counters': { TotalCount: 1, Counters: [{ Name: 'Deaths', Amount: 7 }] },
    });
    bridge = await startTestBridge((c) => {
      c.mixitup.enabled = true;
      c.mixitup.baseUrl = api.url;
      c.broadcaster.twitch = { login: 'teststreamer' };
    });
    client = new TestClient(bridge.port);
    await client.hello();
    await client.request('Subscribe', { events: { Twitch: ['*'], YouTube: ['*'] } });
  });
  after(async () => {
    client.close();
    await bridge.stop();
    await api.close();
  });

  const send = (route: string, body: string) => ingest(bridge.port, client, `mixitup/${route}`, body);

  test('chat message with rich user data, quotes in the text, and black colour dropped', async () => {
    const { events } = await send(
      'chat-message',
      '{"username": "coolviewer", "userdisplayname": "CoolViewer", "usertwitchid": "1001", "usercolor": "#000000", "userismod": "True", "userissubscriber": "True", "usersubmonths": "6", "usersubbadge": "https://badge/sub.png", "message": "a "quoted" word", "streamingplatform": "Twitch"}',
    );
    const d = events[0].data;
    assert.deepEqual(events[0].event, { source: 'Twitch', type: 'ChatMessage' });
    assert.equal(d.text, 'a "quoted" word');
    assert.deepEqual([d.user.id, d.user.login, d.user.name, d.user.color, d.user.role, d.user.subscribed], ['1001', 'coolviewer', 'CoolViewer', '', 3, true]);
    assert.deepEqual(d.user.badges, [{ name: 'subscriber', version: '6', imageUrl: 'https://badge/sub.png' }]);
  });

  test('YouTube chat is routed by $streamingplatform; deletes find the message id', async () => {
    const yt = await send('chat-message', '{"username": "YTUser", "message": "hi", "streamingplatform": "YouTube"}');
    assert.deepEqual(yt.events[0].event, { source: 'YouTube', type: 'Message' });

    const chat = await send('chat-message', '{"username": "spammer", "message": "buy followers", "streamingplatform": "Twitch"}');
    const del = await send('message-deleted', '{"targetusername": "spammer", "message": "buy followers"}');
    assert.equal(del.events[0].event.type, 'ChatMessageDeleted');
    assert.equal(del.events[0].data.messageId, chat.events[0].data.messageId);
  });

  test('subs, gifts, cheers, redemptions, raids, hype trains', async () => {
    const sub = await send('subscribed', '{"username": "a", "usersubplan": "Tier 2"}');
    assert.equal(sub.events[0].data.subTier, '2000');

    const resub = await send('resubscribed', '{"username": "a", "usersubplan": "Prime", "usersubmonths": "12", "message": "yo"}');
    assert.deepEqual([resub.events[0].event.type, resub.events[0].data.isPrime, resub.events[0].data.cumulativeMonths], ['ReSub', true, 12]);

    const gift = await send('subscription-gifted', '{"username": "santa", "targetusername": "kid", "usersubplan": "Tier 1", "usertotalsubsgifted": "40"}');
    assert.deepEqual([gift.events[0].data.recipient.name, gift.events[0].data.cumlativeTotal], ['kid', 40]);

    const bomb = await send('mass-subscriptions-gifted', '{"username": "santa", "subsgiftedamount": "10", "usersubplan": "Tier 1"}');
    assert.deepEqual([bomb.events[0].event.type, bomb.events[0].data.gifts], ['GiftBomb', 10]);

    const cheer = await send('bits-cheered', '{"username": "b", "bitsamount": "500", "message": "Cheer500 wow"}');
    assert.deepEqual(cheer.events[0].data.parts[0], { type: 'cheer', text: 'Cheer500', bits: 500 });

    const reward = await send('channel-points-redeemed', '{"username": "c", "rewardname": "Hydrate", "rewardcost": "100", "message": ""}');
    assert.equal(reward.events[0].data.reward.title, 'Hydrate');

    const raid = await send('raided', '{"username": "raider", "raidviewercount": "33"}');
    assert.equal(raid.events[0].data.viewers, 33);

    const train = await send('hype-train-progress', '{"hypetrainlevel": "2", "hypetrainlevelpoints": "500", "hypetrainlevelgoal": "1000", "hypetraintotalpoints": "1500"}');
    assert.deepEqual([train.events[0].data.level, train.events[0].data.percent, train.events[0].data.total], [2, 50, 1500]);
  });

  test('YouTube membership gift carries gifter and tier', async () => {
    const { events } = await send('youtube-membership-gifted', '{"username": "Giver", "targetusername": "Lucky", "usersubplan": "Gold"}');
    assert.deepEqual([events[0].data.user.name, events[0].data.gifter.name, events[0].data.tier], ['Lucky', 'Giver', 'Gold']);
  });

  test('commands are actions; DoAction passes args as special identifiers', async () => {
    const list = await client.request('GetActions');
    assert.deepEqual(
      list.actions.map((a: any) => [a.name, a.group, a.enabled]),
      [['Lurk', 'Mix It Up Chat', true], ['Hype', 'Alerts', false]],
    );
    assert.equal((await client.request('DoAction', { action: { name: 'Hype' }, args: { user: 'bob', count: 3 } })).status, 'ok');
    const call = api.requests.find((r) => r.url === '/api/v2/commands/c2');
    assert.deepEqual(call?.body, {
      Platform: 'Twitch',
      Arguments: '',
      SpecialIdentifiers: { user: 'bob', count: '3' },
      IgnoreRequirements: true,
    });
  });

  test('SendMessage and counters as globals', async () => {
    assert.equal((await client.request('SendMessage', { platform: 'twitch', message: 'hello', bot: true })).status, 'ok');
    assert.deepEqual(api.requests.find((r) => r.url === '/api/v2/chat/message')?.body, { Message: 'hello', Platform: 'Twitch', SendAsStreamer: false });

    const globals = await client.request('GetGlobals');
    assert.equal(globals.variables.Deaths.value, 7);
  });
});
