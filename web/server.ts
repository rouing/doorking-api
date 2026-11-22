#!/usr/bin/env node

/**
 * @module web/server
 *
 * Localhost-only web UI and REST API for gate pulls (and confirmed sends of the working copy) through DKS Cloud.
 * People sign in with local accounts (src/users.ts); each gate has its own DKS login, saved encrypted with it
 * (src/gate-list.ts), which every DKS call for that gate uses. Gate routes are scoped by path
 * (/api/gates/<phone>/...) and by the user's role on the gate: admin or readonly (see the route scopes).
 * Scheduled transfers run here, unattended. After each transactions pull, camera snapshots are saved for gates
 * with camera settings (see src/cameras.ts). The REST API is documented in docs/API.md.
 */
import * as dk from '../index.ts';
import { Application } from './app.ts';
import { logger } from '../src/logging.ts';

/**
 * The entry point: builds the server's dependencies from the settings (config.json, environment variables and
 * flags; --check-config prints them and exits), then starts it. SIGTERM/SIGINT stop it gracefully; a second signal
 * exits at once.
 */
let config: dk.ServerConfig;
try { config = dk.loadConfig(); } catch (err) {
  console.error(`Configuration error: ${(err as Error).message}`);
  process.exit(1);
}
if (process.argv.includes('--check-config')) {
  console.log(JSON.stringify(dk.maskedConfig(config), null, 2));
  process.exit(0);
}
await dk.configureLogging({ logsDir: config.paths.logs }); // console and logs/server.jsonl
const cameras = dk.createCameraRunner({ ffmpegPath: config.cameras.ffmpeg, log: dk.logMessages('camera') });
const app = new Application({
  config, cameras, mailer: dk.createMailer(config.email),
  storeOptions: { connection: dk.connectionSettings(config.database), keyFile: config.paths.keyFile, poolSize: config.database.poolSize },
});

// Camera bridges are child processes; stop them with the server.
process.on('exit', () => cameras.stopAll());
process.on('uncaughtExceptionMonitor', (error, origin) => logger('server').error`${origin}: ${error && error.stack ? error.stack : error}`);
let signalled = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (signalled) process.exit(1);
    signalled = true;
    app.stop(signal).then(dk.closeLogging).then(() => process.exit(0), () => process.exit(1));
  });
}
try {
  await app.start();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
