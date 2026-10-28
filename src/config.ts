import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import type { LogLevel } from './core/logger.ts';
import type { EnrichmentConfig } from './enrich/enricher.ts';

export interface BridgeConfig {
  logLevel: LogLevel;
  /** What the bridge reports itself as in Hello / GetInfo. */
  instance: { name: string; version: string; instanceId: string };
  websocket: {
    host: string;
    port: number;
    endpoint: string;
    authentication: { enabled: boolean; password: string };
  };
  /** Emulation of Streamer.bot's HTTP server (POST /DoAction, GET /GetActions). */
  httpServer: { enabled: boolean; host: string; port: number };
  /** Token required in the `x-bridge-token` header on /ingest routes. Empty = no check. */
  ingestToken: string;
  /** Manual broadcaster details; adapters fill these in automatically where they can. */
  broadcaster: {
    twitch?: { login: string; displayName?: string; userId?: string; isAffiliate?: boolean; isPartner?: boolean };
    /** Lets widgets with their own Kick connection (e.g. Nutty multichat) find the channel. */
    kick?: { login: string; displayName?: string; userId?: string };
  };
  pronouns: { enabled: boolean };
  /** Public lookups (ivr.fi, 7TV, BTTV, FFZ) that fill in Twitch detail a source app didn't send. */
  enrichment: EnrichmentConfig;
  activeViewerWindowMinutes: number;
  firebot: {
    enabled: boolean;
    baseUrl: string;
    pollIntervalMs: number;
    /** Forward Firebot events with no Streamer.bot equivalent as General.Custom. */
    emitUnmappedAsCustom: boolean;
  };
  aitum: { enabled: boolean; baseUrl: string; pollIntervalMs: number };
  mixitup: {
    enabled: boolean;
    baseUrl: string;
    pollIntervalMs: number;
    /** Run commands via DoAction even if their cooldowns/costs/roles wouldn't allow it. */
    ignoreRequirements: boolean;
  };
  sammi: {
    enabled: boolean;
    baseUrl: string;
    /** SAMMI's local API password, if one is set in SAMMI. */
    password: string;
    pollIntervalMs: number;
    /**
     * SAMMI can't list its buttons, so actions are declared here. A string fires
     * the SAMMI webhook trigger of that name (DoAction args become webhook data);
     * `{ name, buttonId }` triggers that button directly.
     */
    actions: Array<string | { name: string; buttonId?: string; webhook?: string }>;
    /** Global variable names to report in GetGlobals (GetGlobal can read any name). */
    globals: string[];
  };
}

function stableInstanceId(): string {
  const hex = createHash('sha256').update(`sb-bridge:${hostname()}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function defaultConfig(): BridgeConfig {
  return {
    logLevel: 'info',
    instance: { name: 'Streamer.bot', version: '1.0.1', instanceId: stableInstanceId() },
    websocket: {
      host: '127.0.0.1',
      port: 8080,
      endpoint: '/',
      authentication: { enabled: false, password: '' },
    },
    httpServer: { enabled: true, host: '127.0.0.1', port: 7474 },
    ingestToken: '',
    broadcaster: {},
    pronouns: { enabled: true },
    enrichment: {
      enabled: true,
      timeoutMs: 1500,
      users: true,
      rolesAndSubs: true,
      badges: true,
      emotes: true,
      ivrBaseUrl: 'https://api.ivr.fi/v2',
      sevenTvBaseUrl: 'https://7tv.io/v3',
      bttvBaseUrl: 'https://api.betterttv.net/3',
    },
    activeViewerWindowMinutes: 30,
    firebot: { enabled: true, baseUrl: 'http://127.0.0.1:7472', pollIntervalMs: 30_000, emitUnmappedAsCustom: false },
    aitum: { enabled: false, baseUrl: 'http://127.0.0.1:7777', pollIntervalMs: 30_000 },
    mixitup: { enabled: false, baseUrl: 'http://127.0.0.1:8911', pollIntervalMs: 30_000, ignoreRequirements: true },
    sammi: {
      enabled: false,
      baseUrl: 'http://127.0.0.1:9450',
      password: '',
      pollIntervalMs: 30_000,
      actions: [],
      globals: [],
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

/** A relative config path resolves against the working directory, then (as an executable) the folder holding the .exe. */
function findConfigFile(path: string): string {
  const fromCwd = resolve(path);
  if (existsSync(fromCwd) || !isSea()) return fromCwd;
  return resolve(dirname(process.execPath), path);
}

/** Loads `sb-bridge.config.json` (or $SB_BRIDGE_CONFIG) over the defaults, then applies env overrides. */
export function loadConfig(path = process.env.SB_BRIDGE_CONFIG ?? 'sb-bridge.config.json'): BridgeConfig {
  let config = defaultConfig();
  const fullPath = findConfigFile(path);
  if (existsSync(fullPath)) {
    config = deepMerge(config, JSON.parse(readFileSync(fullPath, 'utf8')));
  }

  const env = process.env;
  if (env.SB_BRIDGE_PORT) config.websocket.port = Number(env.SB_BRIDGE_PORT);
  if (env.SB_BRIDGE_HOST) config.websocket.host = env.SB_BRIDGE_HOST;
  if (env.SB_BRIDGE_PASSWORD) config.websocket.authentication = { enabled: true, password: env.SB_BRIDGE_PASSWORD };
  if (env.SB_BRIDGE_LOG_LEVEL) config.logLevel = env.SB_BRIDGE_LOG_LEVEL as LogLevel;
  if (env.FIREBOT_URL) config.firebot.baseUrl = env.FIREBOT_URL;
  if (env.AITUM_URL) config.aitum.baseUrl = env.AITUM_URL;
  if (env.MIXITUP_URL) config.mixitup.baseUrl = env.MIXITUP_URL;
  if (env.SAMMI_URL) config.sammi.baseUrl = env.SAMMI_URL;
  if (env.SAMMI_PASSWORD) config.sammi.password = env.SAMMI_PASSWORD;
  return config;
}
