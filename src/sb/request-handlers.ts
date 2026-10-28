/**
 * Streamer.bot WebSocket requests. Each handler returns the response payload;
 * `id` and `status: "ok"` are added by the server. Throw RequestError for an
 * error response.
 */
import { platform, release } from 'node:os';
import type { Bridge } from '../core/bridge.ts';
import { RequestError, type JsonObject } from '../core/types.ts';
import { SB_EVENTS } from './events-catalog.ts';

export interface SbRequest extends JsonObject {
  request: string;
  id?: string;
}

/** What a handler may touch on the requesting connection. */
export interface SessionView {
  subscribe(events: Record<string, string[]>): void;
  unsubscribe(events: Record<string, string[]>): void;
  subscriptions(): Record<string, string[]>;
}

type Handler = (request: SbRequest, bridge: Bridge, session: SessionView) => Promise<JsonObject> | JsonObject;

const OS_NAMES: Record<string, string> = { win32: 'windows', darwin: 'macosx', linux: 'linux' };

export function instanceInfo(bridge: Bridge, source = 'websocketServer'): JsonObject {
  const { instance } = bridge.config;
  return {
    instanceId: instance.instanceId,
    name: instance.name,
    os: OS_NAMES[platform()] ?? platform(),
    osVersion: release(),
    version: instance.version,
    mode: 'Normal',
    darkMode: true,
    source,
  };
}

function eventMap(value: unknown): Record<string, string[]> {
  if (typeof value !== 'object' || value === null) throw new RequestError('"events" must be an object');
  const out: Record<string, string[]> = {};
  for (const [source, types] of Object.entries(value)) {
    if (Array.isArray(types)) out[source] = types.map(String);
  }
  return out;
}

/** Globals matching the request's `persisted` flag (Streamer.bot defaults it to true). */
async function globalsFor(request: SbRequest, bridge: Bridge) {
  const persisted = request.persisted !== false;
  return (await bridge.getGlobals())
    .filter((g) => (g.persisted ?? true) === persisted)
    .map(({ name, value, lastWrite }) => ({ name, value, lastWrite }));
}

function requireString(request: SbRequest, key: string): string {
  const value = request[key];
  if (typeof value !== 'string' || !value) throw new RequestError(`Missing "${key}"`);
  return value;
}

export const handlers: Record<string, Handler> = {
  GetInfo: (_req, bridge) => ({ info: instanceInfo(bridge) }),

  GetEvents: () => ({ events: SB_EVENTS }),

  Subscribe: (req, _bridge, session) => {
    session.subscribe(eventMap(req.events));
    return { events: session.subscriptions() };
  },

  UnSubscribe: (req, _bridge, session) => {
    session.unsubscribe(eventMap(req.events));
    return { events: session.subscriptions() };
  },

  GetActions: async (_req, bridge) => {
    const actions = await bridge.getActions();
    return { actions, count: actions.length };
  },

  DoAction: async (req, bridge) => {
    const action = (req.action ?? {}) as { id?: string; name?: string };
    if (!action.id && !action.name) throw new RequestError('Missing "action.id" or "action.name"');
    await bridge.doAction(action, (req.args as JsonObject | undefined) ?? {});
    return {};
  },

  GetBroadcaster: (_req, bridge) => {
    const platforms: JsonObject = {};
    const connected: string[] = [];
    const disconnected: string[] = [];
    for (const name of ['twitch', 'youtube', 'kick'] as const) {
      const info = bridge.getBroadcasters().get(name);
      if (info) platforms[name] = info.data;
      (info?.connected ? connected : disconnected).push(name);
    }
    return { platforms, connected, disconnected };
  },

  GetActiveViewers: (_req, bridge) => {
    const viewers = bridge.viewers.list();
    return { viewers, count: viewers.length };
  },

  GetCredits: (_req, bridge) => bridge.credits.snapshot(),
  TestCredits: (_req, bridge) => {
    bridge.credits.fillTestData();
    return bridge.credits.snapshot();
  },
  ClearCredits: (_req, bridge) => {
    bridge.credits.clear();
    return {};
  },

  GetGlobals: async (req, bridge) => {
    const globals = await globalsFor(req, bridge);
    return { variables: Object.fromEntries(globals.map((g) => [g.name, g])), count: globals.length };
  },

  GetGlobal: async (req, bridge) => {
    const name = requireString(req, 'variable');
    let found = (await globalsFor(req, bridge)).find((g) => g.name === name);
    if (!found && req.persisted !== false) {
      const direct = await bridge.getGlobal(name);
      if (direct) found = { name: direct.name, value: direct.value, lastWrite: direct.lastWrite };
    }
    if (!found) throw new RequestError(`Global variable "${name}" not found`);
    return { variable: found };
  },

  // Per-user globals have no equivalent in the source apps.
  GetUserGlobals: () => ({ variables: [], count: 0 }),
  GetUserGlobal: () => ({ variables: [], count: 0 }),
  TwitchGetUserGlobals: () => ({ variables: [], count: 0 }),
  TwitchGetUserGlobal: () => ({ variables: [], count: 0 }),

  SendMessage: async (req, bridge) => {
    const message = requireString(req, 'message');
    await bridge.sendMessage(String(req.platform ?? 'twitch').toLowerCase(), message, {
      bot: Boolean(req.bot),
      internal: req.internal !== false,
    });
    return {};
  },

  GetUserPronouns: async (req, bridge) => {
    const userLogin = requireString(req, 'userLogin');
    return { userLogin, pronoun: await bridge.pronouns.lookup(userLogin) };
  },

  GetCommands: () => ({ commands: [], count: 0 }),
  GetCodeTriggers: () => ({ triggers: [], count: 0 }),
  ExecuteCodeTrigger: () => {
    throw new RequestError('Code triggers are not supported by sb-bridge');
  },

  TwitchGetEmotes: () => ({ emotes: { userEmotes: [], bttvEmotes: [], ffzEmotes: [], sevenTvEmotes: [] } }),
  YouTubeGetEmotes: () => ({ emotes: { userEmotes: [], bttvEmotes: [], ffzEmotes: [], sevenTvEmotes: [] } }),
  GetEmotes: () => ({ emotes: { userEmotes: [], bttvEmotes: [], ffzEmotes: [], sevenTvEmotes: [] } }),
  GetMonitoredYouTubeBroadcasts: () => ({ broadcasts: [], count: 0 }),
};
