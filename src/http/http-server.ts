/**
 * HTTP endpoints:
 *  - Main server (same port as the WebSocket): ingest routes that source apps
 *    push events into, plus /health.
 *  - Optional Streamer.bot HTTP server emulation: POST /DoAction, GET /GetActions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Bridge } from '../core/bridge.ts';
import { createLogger } from '../core/logger.ts';
import { RequestError, type JsonObject } from '../core/types.ts';

const log = createLogger('http');
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** Parsed JSON, `{}` for an empty body, undefined for invalid JSON. */
function tryParse(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = tryParse(await readText(req));
  if (body === undefined) throw new HttpError(400, 'Body is not valid JSON');
  return body;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-bridge-token',
  });
  res.end(JSON.stringify(body));
}

type Route = (req: IncomingMessage, segments: string[]) => Promise<unknown>;

function serve(routes: (method: string, segments: string[]) => Route | undefined) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const segments = new URL(req.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean);
    const route = routes(req.method ?? 'GET', segments);
    if (!route) return send(res, 404, { status: 'error', error: 'Not found' });
    try {
      send(res, 200, (await route(req, segments)) ?? { status: 'ok' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof RequestError ? 400 : 500;
      if (status === 500) log.error(`${req.method} ${req.url} failed:`, err);
      send(res, status, { status: 'error', error: (err as Error).message });
    }
  };
}

/** Accepts `{event:{source,type},data}` (Streamer.bot broadcast shape) or `{source,type,data}`. */
function parseSbEvent(value: unknown): { source: string; type: string; data: unknown } {
  const body = (value ?? {}) as JsonObject;
  const event = (body.event ?? body) as JsonObject;
  if (typeof event.source !== 'string' || typeof event.type !== 'string') {
    throw new HttpError(400, 'Expected {"event":{"source","type"},"data"} or {"source","type","data"}');
  }
  return { source: event.source, type: event.type, data: body.data ?? {} };
}

export function createMainServer(bridge: Bridge): Server {
  const checkToken = (req: IncomingMessage) => {
    const token = bridge.config.ingestToken;
    if (!token) return;
    // Query-string form is for senders that can't set headers (Aitum's Send Webhook).
    const supplied = req.headers['x-bridge-token'] ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    if (supplied !== token) throw new HttpError(401, 'Invalid ingest token');
  };

  return createServer(
    serve((method, [root, target, ...rest]) => {
      if (method === 'GET' && root === 'health') {
        return async () => ({ status: 'ok', adapters: [...bridge.adapters.keys()] });
      }
      if (method !== 'POST' || root !== 'ingest' || !target) return undefined;

      if (target === 'event') {
        return async (req) => {
          checkToken(req);
          const body = await readJson(req);
          for (const item of Array.isArray(body) ? body : [body]) {
            const { source, type, data } = parseSbEvent(item);
            await bridge.emit('ingest', source, type, data);
          }
        };
      }
      if (target === 'custom') {
        return async (req) => {
          checkToken(req);
          await bridge.emit('ingest', 'General', 'Custom', await readJson(req));
        };
      }
      const adapter = bridge.adapters.get(target);
      if (!adapter?.handleIngest) return undefined;
      return async (req) => {
        checkToken(req);
        const raw = await readText(req);
        return adapter.handleIngest!(rest.join('/'), tryParse(raw), raw);
      };
    }),
  );
}

export function createSbHttpServer(bridge: Bridge): Server {
  return createServer(
    serve((method, [root]) => {
      if (method === 'POST' && root?.toLowerCase() === 'doaction') {
        return async (req) => {
          const body = (await readJson(req)) as JsonObject;
          const action = (body.action ?? {}) as { id?: string; name?: string };
          if (!action.id && !action.name) throw new HttpError(400, 'Missing action.id or action.name');
          await bridge.doAction(action, (body.args as JsonObject | undefined) ?? {});
          return { status: 'ok' };
        };
      }
      if (method === 'GET' && root?.toLowerCase() === 'getactions') {
        return async () => {
          const actions = await bridge.getActions();
          return { actions, count: actions.length };
        };
      }
      return undefined;
    }),
  );
}
