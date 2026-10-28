import { WebSocket } from 'ws';
import { defaultConfig, type BridgeConfig } from '../src/config.ts';
import { startBridge, type RunningBridge } from '../src/index.ts';

export async function startTestBridge(overrides: (c: BridgeConfig) => void = () => {}): Promise<RunningBridge & { port: number }> {
  const config = defaultConfig();
  config.logLevel = 'error';
  config.websocket.port = 0;
  config.httpServer.enabled = false;
  config.firebot.enabled = false;
  config.pronouns.enabled = false;
  // Never reach real public APIs from tests; enrichment tests point these at startFakeApi.
  config.enrichment.enabled = false;
  overrides(config);
  const running = await startBridge(config);
  const address = running.mainServer.address();
  return { ...running, port: typeof address === 'object' && address ? address.port : 0 };
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

/** A stand-in for an app's local HTTP API. `routes` maps "METHOD /path?query" to a JSON reply. */
export async function startFakeApi(routes: Record<string, unknown>) {
  const { createServer } = await import('node:http');
  const requests: FakeRequest[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const key = `${req.method} ${req.url}`;
    requests.push({ method: req.method!, url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : undefined });
    const match = Object.keys(routes).find((r) => r === key || (r.endsWith('*') && key.startsWith(r.slice(0, -1))));
    res.writeHead(match ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(match ? routes[match] : { Error: 'not found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

/** POSTs to an ingest route and waits for the next event the client receives. */
export async function ingest(port: number, client: TestClient, route: string, body: string) {
  const before = client.messages.length;
  const res = await fetch(`http://127.0.0.1:${port}/ingest/${route}`, { method: 'POST', body });
  const json = await res.json();
  if (res.status !== 200 || !json.emitted?.length) return { status: res.status, json, events: [] as any[] };
  await client.waitFor((m) => m.event && client.messages.indexOf(m) >= before + json.emitted.length - 1);
  return { status: res.status, json, events: client.messages.slice(before).filter((m) => m.event) };
}

/** Minimal Streamer.bot client: collects messages, sends requests and awaits replies by id. */
export class TestClient {
  readonly ws: WebSocket;
  readonly messages: any[] = [];
  #waiters: Array<{ match: (m: any) => boolean; resolve: (m: any) => void }> = [];
  #nextId = 1;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      this.#waiters = this.#waiters.filter((w) => (w.match(message) ? (w.resolve(message), false) : true));
    });
  }

  waitFor(match: (m: any) => boolean, timeoutMs = 2000): Promise<any> {
    const existing = this.messages.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      this.#waiters.push({ match, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  hello(): Promise<any> {
    return this.waitFor((m) => m.request === 'Hello');
  }

  async request(request: string, fields: Record<string, unknown> = {}): Promise<any> {
    const id = String(this.#nextId++);
    const reply = this.waitFor((m) => m.id === id);
    this.ws.send(JSON.stringify({ request, id, ...fields }));
    return reply;
  }

  close(): void {
    this.ws.close();
  }
}
