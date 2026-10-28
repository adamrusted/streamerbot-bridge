/**
 * End-to-end against the official @streamerbot/client, the library widgets
 * like the Nutty multichat overlay use. Exercises the same calls the overlay
 * makes: .on('Twitch.ChatMessage'), getBroadcaster(), getUserPronouns().
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { StreamerbotClient } from '@streamerbot/client';
import { startTestBridge } from './helpers.ts';

let bridge: Awaited<ReturnType<typeof startTestBridge>>;

before(async () => {
  bridge = await startTestBridge((c) => {
    c.broadcaster.twitch = { login: 'teststreamer', displayName: 'TestStreamer' };
    c.websocket.authentication = { enabled: true, password: 'pw' };
  });
});
after(() => bridge.stop());

function connect(): Promise<StreamerbotClient> {
  return new Promise((resolve, reject) => {
    const client: StreamerbotClient = new StreamerbotClient({
      host: '127.0.0.1',
      port: bridge.port,
      password: 'pw',
      autoReconnect: false,
      logLevel: 'none',
      onConnect: () => resolve(client),
      onError: (err) => reject(err),
    });
  });
}

test('official client connects, authenticates, subscribes and receives events', async () => {
  const client = await connect();
  try {
    const received = new Promise<any>((resolve) => client.on('Twitch.ChatMessage', resolve));
    // .on() subscribes asynchronously; wait until the server has registered it.
    await new Promise((r) => setTimeout(r, 200));

    const firebot = await import('../src/adapters/firebot/firebot-mapper.ts');
    const mapper = new firebot.FirebotEventMapper({ channel: () => bridge.bridge.twitchChannel(), emitUnmappedAsCustom: false });
    for (const out of mapper.map({ sourceId: 'twitch', eventId: 'chat-message', meta: { username: 'viewer', userId: '5', messageText: 'hi there' } })) {
      bridge.bridge.bus.publish('test', out.source, out.type, out.data);
    }

    const event = await received;
    assert.deepEqual(event.event, { source: 'Twitch', type: 'ChatMessage' });
    assert.equal(event.data.text, 'hi there');
    assert.equal(event.data.user.login, 'viewer');

    const broadcaster: any = await client.getBroadcaster();
    assert.equal(broadcaster.platforms.twitch.broadcastUserName, 'teststreamer');

    const pronouns: any = await client.getUserPronouns('twitch', 'viewer');
    assert.equal(pronouns.pronoun.userFound, false);
  } finally {
    await client.disconnect();
  }
});
