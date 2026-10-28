import { loadConfig } from './config.ts';
import { createLogger } from './core/logger.ts';
import { startBridge } from './index.ts';

// Kept free of top-level await so the CommonJS bundle used for the executable can run it.
const log = createLogger('main');

startBridge(loadConfig()).then(
  (running) => {
    const shutdown = async () => {
      log.info('shutting down');
      await running.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  },
  (err) => {
    log.error(`failed to start: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
