import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createSweep } from './keeper.ts';
import { createOneClick } from './oneclick.ts';
import { createWatcher } from './watcher.ts';

const POLL_INTERVAL_MS = 5000;

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const oneClick = createOneClick(config.oneClickApiKey);
const watcher = createWatcher(oneClick, createSweep(config));
const server = createServer(
  createApp({ predayContract: config.predayContract, allowedOrigin: config.allowedOrigin, oneClick, watcher }),
);

const stopWatching = watcher.start(POLL_INTERVAL_MS);
server.listen(config.port, () => console.log(`preday service listening on :${config.port}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopWatching();
    server.close();
  });
}
