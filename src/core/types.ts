export type JsonObject = Record<string, unknown>;

/** An event in Streamer.bot shape, ready to broadcast to subscribed clients. */
export interface BridgeEvent {
  source: string;
  type: string;
  data: unknown;
  timeStamp: string;
  /** Which adapter produced the event (not sent to clients). */
  origin: string;
}

/** An adapter's translation result, before the bus stamps it. */
export interface SbEventOut {
  source: string;
  type: string;
  data: unknown;
}

/** Mirrors the entries of a Streamer.bot `GetActions` response. */
export interface ActionInfo {
  id: string;
  name: string;
  group: string;
  enabled: boolean;
  subaction_count: number;
  trigger_count: number;
}

export interface GlobalVariable {
  name: string;
  value: unknown;
  lastWrite: string;
  /** Streamer.bot separates persisted and temporary globals; defaults to true. */
  persisted?: boolean;
}

export type BroadcasterPlatform = 'twitch' | 'youtube' | 'kick';

export interface BroadcasterInfo {
  platform: BroadcasterPlatform;
  connected: boolean;
  data: JsonObject;
}

export interface SendMessageOptions {
  bot: boolean;
  internal: boolean;
}

/**
 * A connection to a streaming application. Every capability is optional so an
 * adapter only implements what its application can actually do.
 */
export interface Adapter {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getActions?(): Promise<ActionInfo[]>;
  runAction?(actionId: string, args: JsonObject): Promise<void>;
  /** Returns false when the adapter cannot deliver to that platform. */
  sendMessage?(platform: string, message: string, options: SendMessageOptions): Promise<boolean>;
  getGlobals?(): Promise<GlobalVariable[]>;
  /** Direct lookup, for apps that can't enumerate their variables (SAMMI). */
  getGlobal?(name: string): Promise<GlobalVariable | undefined>;
  getBroadcasters?(): BroadcasterInfo[];
  /**
   * Handles `POST /ingest/<adapter id>/<subPath>`. `body` is undefined when the
   * request wasn't valid JSON; `rawBody` is always the original text.
   */
  handleIngest?(subPath: string, body: unknown, rawBody: string): Promise<unknown>;
}

export class RequestError extends Error {}
