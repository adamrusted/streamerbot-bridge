/**
 * Enrichment against fake ivr.fi / 7TV / BTTV servers, using response shapes
 * captured from the live APIs. Exercises the Aitum path, which has the least
 * detail to start with.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ingest, startFakeApi, startTestBridge, TestClient } from './helpers.ts';

const badge = (id: string) => ({ id, image_url_1x: `https://badge/${id}/1`, image_url_2x: `https://badge/${id}/2` });

describe('enrichment', () => {
  let bridge: Awaited<ReturnType<typeof startTestBridge>>;
  let client: TestClient;
  let api: Awaited<ReturnType<typeof startFakeApi>>;

  before(async () => {
    api = await startFakeApi({
      'GET /ivr/twitch/user?login=teststreamer': [
        { id: '42', login: 'teststreamer', displayName: 'TestStreamer', chatColor: '#FF0000', logo: 'https://logo/42', roles: { isPartner: true, isAffiliate: false } },
      ],
      'GET /ivr/twitch/user?login=coolviewer': [
        { id: '1001', login: 'coolviewer', displayName: 'CoolViewer', chatColor: '#00FF00', logo: 'https://logo/1001', roles: {} },
      ],
      'GET /ivr/twitch/user?login=*': [],
      'GET /ivr/twitch/modvip/teststreamer': { mods: [{ id: '1001', login: 'coolviewer' }], vips: [], ttl: null },
      'GET /ivr/twitch/subage/coolviewer/teststreamer': {
        meta: { type: 'paid', tier: '2' },
        cumulative: { months: 7 },
      },
      'GET /ivr/twitch/subage/*': { meta: null, cumulative: null },
      'GET /ivr/twitch/badges/global': [
        { set_id: 'moderator', versions: [badge('mod1')] },
        { set_id: 'subscriber', versions: [badge('gsub0')] },
      ],
      'GET /ivr/twitch/badges/channel?login=teststreamer': [
        { set_id: 'subscriber', versions: [badge('0'), badge('3'), badge('6'), badge('2000'), badge('2003'), badge('2006'), badge('2012')] },
      ],
      'GET /ivr/twitch/emotes/channel/teststreamer': {
        subProducts: [{ emotes: [{ id: 'emotesv2_abc', code: 'testHype' }] }],
      },
      'GET /7tv/emote-sets/global': { emotes: [{ id: 's1', name: 'peepoShake', data: { host: { url: '//cdn.7tv.app/emote/s1' } } }] },
      'GET /7tv/users/twitch/42': { emote_set: { emotes: [] } },
      'GET /bttv/cached/emotes/global': [{ id: 'b1', code: 'catJAM' }],
      'GET /bttv/cached/users/twitch/42': { channelEmotes: [], sharedEmotes: [] },
      'GET /bttv/cached/frankerfacez/emotes/global': [],
      'GET /bttv/cached/frankerfacez/users/twitch/42': [],
    });
    bridge = await startTestBridge((c) => {
      c.aitum.enabled = true;
      c.aitum.baseUrl = 'http://127.0.0.1:1';
      c.broadcaster.twitch = { login: 'teststreamer' };
      c.enrichment = {
        ...c.enrichment,
        enabled: true,
        timeoutMs: 3000,
        ivrBaseUrl: `${api.url}/ivr`,
        sevenTvBaseUrl: `${api.url}/7tv`,
        bttvBaseUrl: `${api.url}/bttv`,
      };
    });
    client = new TestClient(bridge.port);
    await client.hello();
    await client.request('Subscribe', { events: { Twitch: ['*'] } });
  });
  after(async () => {
    client.close();
    await bridge.stop();
    await api.close();
  });

  test('Aitum chat gains real id, colour, avatar, mod role, sub status, badges and emotes', async () => {
    const { events } = await ingest(
      bridge.port,
      client,
      'aitum/twitch/chat-message',
      '{"username": "CoolViewer", "message": "hello Kappa testHype catJAM peepoShake bye"}',
    );
    const d = events[0].data;
    assert.equal(d.user.id, '1001');
    assert.equal(d.message.userId, '1001', 'legacy mirror follows the real id');
    assert.equal(d.user.color, '#00FF00');
    assert.equal(d.message.color, '#00FF00');
    assert.equal(d.user.profileImageUrl, 'https://logo/1001');
    assert.deepEqual([d.user.role, d.user.isModerator], [3, true]);
    assert.deepEqual([d.user.subscribed, d.user.subscriptionTier, d.user.monthsSubscribed], [true, '2000', 7]);
    assert.deepEqual(
      d.user.badges.map((b: any) => [b.name, b.imageUrl]),
      [
        ['moderator', 'https://badge/mod1/2'],
        ['subscriber', 'https://badge/2006/2'], // tier 2, 7 months → the 6-month tier-2 badge
      ],
    );
    assert.deepEqual(
      d.parts.map((p: any) => (p.type === 'emote' ? `${p.source}:${p.text}` : p.text)),
      ['hello ', 'Twitch:Kappa', ' ', 'Twitch:testHype', ' ', 'BTTV:catJAM', ' ', '7TV:peepoShake', ' bye'],
    );
    assert.equal(d.parts[3].imageUrl, 'https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_abc/default/dark/2.0');
    assert.equal(d.message.emotes.length, 4, 'legacy emotes array is rebuilt');
  });

  test('unknown users keep their placeholder id; cheermotes get images', async () => {
    const { events } = await ingest(bridge.port, client, 'aitum/twitch/bit-cheer', '{"username": "Nobody", "bits": "100", "message": "Cheer100"}');
    const d = events[0].data;
    assert.equal(d.user.id, 'aitum-nobody');
    assert.deepEqual(d.user.badges, []);
    assert.equal(d.parts[0].imageUrl, 'https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/4.gif');
  });

  test('GetBroadcaster fills the id and partner flag from the lookup', async () => {
    const res = await client.request('GetBroadcaster');
    assert.deepEqual(
      [res.platforms.twitch.broadcastUserId, res.platforms.twitch.broadcastIsPartner, res.platforms.twitch.broadcastUser],
      ['42', true, 'TestStreamer'],
    );
  });

  test('events stay in arrival order even when an earlier one waits on a lookup', async () => {
    const before = client.messages.length;
    await Promise.all([
      fetch(`http://127.0.0.1:${bridge.port}/ingest/aitum/twitch/chat-message`, { method: 'POST', body: '{"username": "SlowNewUser", "message": "first"}' }),
      fetch(`http://127.0.0.1:${bridge.port}/ingest/aitum/twitch/chat-message`, { method: 'POST', body: '{"username": "CoolViewer", "message": "second"}' }),
    ]);
    await client.waitFor((m) => m.event && m.data.text === 'second');
    const texts = client.messages.slice(before).filter((m) => m.event).map((m) => m.data.text);
    assert.deepEqual(texts, ['first', 'second']);
  });
});
