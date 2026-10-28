/**
 * Streamer.bot-compatible WebSocket server: Hello on connect, optional
 * challenge/response auth, request/response by `id`, and per-connection event
 * subscriptions.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Bridge } from '../core/bridge.ts';
import { createLogger } from '../core/logger.ts';
import { RequestError, type BridgeEvent, type JsonObject } from '../core/types.ts';
import { createChallenge, verifyAuthentication } from './auth.ts';
import { handlers, instanceInfo, type SbRequest, type SessionView } from './request-handlers.ts';

const log = createLogger('sb-ws');
const WILDCARD = '*';

class Session implements SessionView {
  readonly id = randomUUID();
  readonly ws: WebSocket;
  readonly auth: { salt: string; challenge: string } | undefined;
  authenticated: boolean;
  #subs = new Map<string, Set<string>>();

  constructor(ws: WebSocket, requireAuth: boolean) {
    this.ws = ws;
    this.auth = requireAuth ? createChallenge() : undefined;
    this.authenticated = !requireAuth;
  }

  subscribe(events: Record<string, string[]>): void {
    for (const [source, types] of Object.entries(events)) {
      const set = this.#subs.get(source) ?? new Set();
      types.forEach((t) => set.add(t));
      this.#subs.set(source, set);
    }
  }

  unsubscribe(events: Record<string, string[]>): void {
    for (const [source, types] of Object.entries(events)) {
      const set = this.#subs.get(source);
      if (!set) continue;
      types.forEach((t) => set.delete(t));
      if (set.size === 0) this.#subs.delete(source);
    }
  }

  subscriptions(): Record<string, string[]> {
    return Object.fromEntries([...this.#subs].map(([source, types]) => [source, [...types]]));
  }

  wants(event: BridgeEvent): boolean {
    const types = this.#subs.get(event.source) ?? this.#subs.get(WILDCARD);
    return Boolean(types && (types.has(event.type) || types.has(WILDCARD)));
  }

  send(payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}

export class SbWebSocketServer {
  #bridge: Bridge;
  #wss = new WebSocketServer({ noServer: true });
  #sessions = new Set<Session>();
  #unsubscribeBus: () => void;

  constructor(bridge: Bridge) {
    this.#bridge = bridge;
    this.#wss.on('connection', (ws) => this.#onConnection(ws));
    this.#unsubscribeBus = bridge.bus.subscribe((event) => this.broadcast(event));
  }

  /** Accepts upgrades on the configured endpoint of an existing HTTP server. */
  attach(server: Server, endpoint: string): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (normalizePath(path) !== normalizePath(endpoint)) {
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit('connection', ws, req));
    });
  }

  get clientCount(): number {
    return this.#sessions.size;
  }

  broadcast(event: BridgeEvent): void {
    const payload = { timeStamp: event.timeStamp, event: { source: event.source, type: event.type }, data: event.data };
    let delivered = 0;
    for (const session of this.#sessions) {
      if (session.authenticated && session.wants(event)) {
        session.send(payload);
        delivered++;
      }
    }
    log.debug(`${event.source}.${event.type} (from ${event.origin}) -> ${delivered} client(s)`);
  }

  close(): void {
    this.#unsubscribeBus();
    for (const session of this.#sessions) session.ws.close(1001, 'Server shutting down');
    this.#wss.close();
  }

  #onConnection(ws: WebSocket): void {
    const { authentication } = this.#bridge.config.websocket;
    const session = new Session(ws, authentication.enabled);
    this.#sessions.add(session);
    log.info(`client connected (${this.#sessions.size} total)`);

    session.send({
      timestamp: new Date().toISOString(),
      session: session.id,
      request: 'Hello',
      info: instanceInfo(this.#bridge),
      ...(session.auth ? { authentication: session.auth } : {}),
    });

    ws.on('message', (raw) => void this.#onMessage(session, raw.toString()));
    ws.on('close', () => {
      this.#sessions.delete(session);
      log.info(`client disconnected (${this.#sessions.size} total)`);
    });
    ws.on('error', (err) => log.warn('socket error:', err.message));
  }

  async #onMessage(session: Session, raw: string): Promise<void> {
    let request: SbRequest;
    try {
      request = JSON.parse(raw);
      if (typeof request?.request !== 'string') throw new Error('missing "request"');
    } catch (err) {
      session.send({ status: 'error', error: `Invalid request: ${(err as Error).message}` });
      return;
    }
    const id = request.id;
    const respond = (payload: JsonObject) => session.send({ ...payload, id, status: 'ok' });
    const fail = (error: string) => session.send({ id, status: 'error', error });

    if (request.request === 'Authenticate') {
      const { password } = this.#bridge.config.websocket.authentication;
      if (!session.auth) return respond({});
      if (verifyAuthentication(password, session.auth.salt, session.auth.challenge, request.authentication)) {
        session.authenticated = true;
        log.info('client authenticated');
        return respond({});
      }
      fail('Authentication failed');
      session.ws.close(4001, 'Authentication failed');
      return;
    }

    if (!session.authenticated) return fail('Authentication required');

    const handler = handlers[request.request];
    if (!handler) return fail(`Unknown request: ${request.request}`);
    try {
      respond(await handler(request, this.#bridge, session));
    } catch (err) {
      if (!(err instanceof RequestError)) log.error(`${request.request} failed:`, err);
      fail((err as Error).message);
    }
  }
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
