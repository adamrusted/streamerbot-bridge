import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { computeAuthentication } from '../src/sb/auth.ts';
import type { Adapter } from '../src/core/types.ts';
import { startTestBridge, TestClient } from './helpers.ts';

describe('Streamer.bot WebSocket server', () => {
  let bridge: Awaited<ReturnType<typeof startTestBridge>>;
  const ran: Array<{ id: string; args: unknown }> = [];

  before(async () => {
    bridge = await startTestBridge((c) => {
      c.broadcaster.twitch = { login: 'teststreamer', displayName: 'TestStreamer', userId: '42' };
      c.broadcaster.kick = { login: 'KickStreamer' };
    });
    const fake: Adapter = {
      id: 'fake',
      start: async () => {},
      stop: async () => {},
      getActions: async () => [
        { id: 'a-1', name: 'Shout', group: 'Fake', enabled: true, subaction_count: 1, trigger_count: 0 },
      ],
      runAction: async (id, args) => void ran.push({ id, args }),
      getGlobals: async () => [{ name: 'counter', value: 3, lastWrite: '2026-01-01T00:00:00Z' }],
    };
    bridge.bridge.register(fake);
  });
  after(() => bridge.stop());

  test('sends Hello with instance info on connect', async () => {
    const client = new TestClient(bridge.port);
    const hello = await client.hello();
    assert.equal(hello.info.name, 'Streamer.bot');
    assert.equal(hello.info.source, 'websocketServer');
    assert.equal(hello.authentication, undefined);
    client.close();
  });

  test('delivers only subscribed events in Streamer.bot shape', async () => {
    const client = new TestClient(bridge.port);
    await client.hello();
    const sub = await client.request('Subscribe', { events: { Twitch: ['ChatMessage'] } });
    assert.deepEqual(sub, { events: { Twitch: ['ChatMessage'] }, id: sub.id, status: 'ok' });

    bridge.bridge.bus.publish('test', 'Twitch', 'Follow', { ignored: true });
    bridge.bridge.bus.publish('test', 'Twitch', 'ChatMessage', { text: 'hi' });
    const event = await client.waitFor((m) => m.event);
    assert.deepEqual(event.event, { source: 'Twitch', type: 'ChatMessage' });
    assert.equal(event.data.text, 'hi');
    assert.ok(event.timeStamp);
    assert.equal(client.messages.filter((m) => m.event).length, 1);

    const unsub = await client.request('UnSubscribe', { events: { Twitch: ['ChatMessage'] } });
    assert.deepEqual(unsub.events, {});
    client.close();
  });

  test('supports wildcard subscriptions', async () => {
    const client = new TestClient(bridge.port);
    await client.hello();
    await client.request('Subscribe', { events: { General: ['*'] } });
    bridge.bridge.bus.publish('test', 'General', 'Custom', { a: 1 });
    const event = await client.waitFor((m) => m.event);
    assert.deepEqual(event.data, { a: 1 });
    client.close();
  });

  test('GetActions and DoAction route to the owning adapter (by id or name)', async () => {
    const client = new TestClient(bridge.port);
    await client.hello();
    const list = await client.request('GetActions');
    assert.equal(list.count, 1);
    assert.equal(list.actions[0].name, 'Shout');

    assert.equal((await client.request('DoAction', { action: { name: 'shout' }, args: { x: 1 } })).status, 'ok');
    assert.deepEqual(ran.at(-1), { id: 'a-1', args: { x: 1 } });

    const missing = await client.request('DoAction', { action: { name: 'nope' } });
    assert.equal(missing.status, 'error');
    client.close();
  });

  test('GetBroadcaster, GetGlobals, GetUserPronouns, unknown requests', async () => {
    const client = new TestClient(bridge.port);
    await client.hello();

    const broadcaster = await client.request('GetBroadcaster');
    assert.equal(broadcaster.platforms.twitch.broadcastUserName, 'teststreamer');
    // Nutty multichat reads platforms.kick.broadcasterLogin to start its own Kick connection
    assert.equal(broadcaster.platforms.kick.broadcasterLogin, 'kickstreamer');
    assert.deepEqual(broadcaster.disconnected.sort(), ['kick', 'twitch', 'youtube']);

    const globals = await client.request('GetGlobals', { persisted: true });
    assert.equal(globals.variables.counter.value, 3);

    const pronouns = await client.request('GetUserPronouns', { platform: 'twitch', userLogin: 'someone' });
    assert.equal(pronouns.pronoun.userFound, false);

    const unknown = await client.request('NotARealRequest');
    assert.equal(unknown.status, 'error');
    client.close();
  });
});

describe('authentication', () => {
  let bridge: Awaited<ReturnType<typeof startTestBridge>>;
  before(async () => {
    bridge = await startTestBridge((c) => {
      c.websocket.authentication = { enabled: true, password: 'hunter2' };
    });
  });
  after(() => bridge.stop());

  test('rejects requests until authenticated, accepts the Streamer.bot hash', async () => {
    const client = new TestClient(bridge.port);
    const hello = await client.hello();
    assert.ok(hello.authentication.salt && hello.authentication.challenge);

    assert.equal((await client.request('GetInfo')).status, 'error');

    const { salt, challenge } = hello.authentication;
    const auth = await client.request('Authenticate', { authentication: computeAuthentication('hunter2', salt, challenge) });
    assert.equal(auth.status, 'ok');
    assert.equal((await client.request('GetInfo')).status, 'ok');
    client.close();
  });

  test('closes the socket on a wrong password', async () => {
    const client = new TestClient(bridge.port);
    await client.hello();
    const closed = new Promise<number>((resolve) => client.ws.on('close', resolve));
    const auth = await client.request('Authenticate', { authentication: 'wrong' });
    assert.equal(auth.status, 'error');
    assert.equal(await closed, 4001);
  });
});

describe('HTTP ingest', () => {
  let bridge: Awaited<ReturnType<typeof startTestBridge>>;
  before(async () => {
    bridge = await startTestBridge((c) => {
      c.ingestToken = 'secret';
    });
  });
  after(() => bridge.stop());

  test('POST /ingest/event broadcasts Streamer.bot-shaped events and checks the token', async () => {
    const client = new TestClient(bridge.port);
    await client.hello();
    await client.request('Subscribe', { events: { Kofi: ['Donation'] } });

    const url = `http://127.0.0.1:${bridge.port}/ingest/event`;
    const body = JSON.stringify({ event: { source: 'Kofi', type: 'Donation' }, data: { amount: 5 } });
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);

    const res = await fetch(url, { method: 'POST', body, headers: { 'x-bridge-token': 'secret' } });
    assert.equal(res.status, 200);
    const event = await client.waitFor((m) => m.event);
    assert.equal(event.data.amount, 5);

    assert.equal((await fetch(`${url}?token=secret`, { method: 'POST', body })).status, 200);
    client.close();
  });
});
