import type { Server } from 'node:http';
import { AitumAdapter } from './adapters/aitum/aitum-adapter.ts';
import { FirebotAdapter } from './adapters/firebot/firebot-adapter.ts';
import { MixItUpAdapter } from './adapters/mixitup/mixitup-adapter.ts';
import { SammiAdapter } from './adapters/sammi/sammi-adapter.ts';
import type { BridgeConfig } from './config.ts';
import { Bridge } from './core/bridge.ts';
import { createLogger, setLogLevel } from './core/logger.ts';
import { createMainServer, createSbHttpServer } from './http/http-server.ts';
import { SbWebSocketServer } from './sb/sb-websocket-server.ts';

const log = createLogger('main');

export interface RunningBridge {
  bridge: Bridge;
  wsServer: SbWebSocketServer;
  mainServer: Server;
  httpServer?: Server;
  stop(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}

export async function startBridge(config: BridgeConfig): Promise<RunningBridge> {
  setLogLevel(config.logLevel);
  const bridge = new Bridge(config);
  if (config.firebot.enabled) bridge.register(new FirebotAdapter(bridge));
  if (config.aitum.enabled) bridge.register(new AitumAdapter(bridge));
  if (config.mixitup.enabled) bridge.register(new MixItUpAdapter(bridge));
  if (config.sammi.enabled) bridge.register(new SammiAdapter(bridge));

  const { host, port, endpoint, authentication } = config.websocket;
  const mainServer = createMainServer(bridge);
  const wsServer = new SbWebSocketServer(bridge);
  wsServer.attach(mainServer, endpoint);
  await listen(mainServer, port, host);
  const address = mainServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  log.info(`Streamer.bot WebSocket API on ws://${host}:${boundPort}${endpoint} (auth ${authentication.enabled ? 'on' : 'off'})`);
  log.info(`ingest endpoints on http://${host}:${boundPort}/ingest/...`);

  let httpServer: Server | undefined;
  if (config.httpServer.enabled) {
    httpServer = createSbHttpServer(bridge);
    try {
      await listen(httpServer, config.httpServer.port, config.httpServer.host);
      log.info(`Streamer.bot HTTP API on http://${config.httpServer.host}:${config.httpServer.port}`);
    } catch (err) {
      log.warn(`Streamer.bot HTTP API disabled: ${(err as Error).message}`);
      httpServer = undefined;
    }
  }

  await bridge.start();

  return {
    bridge,
    wsServer,
    mainServer,
    httpServer,
    async stop() {
      wsServer.close();
      await bridge.stop();
      await Promise.all(
        [mainServer, httpServer].filter(Boolean).map((s) => {
          const closed = new Promise((r) => s!.close(() => r(undefined)));
          s!.closeAllConnections();
          return closed;
        }),
      );
    },
  };
}
