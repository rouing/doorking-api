// The server as one object: built from its dependencies (no I/O in the constructor), started and stopped explicitly,
// so tests can run a real server on a test database and a spare port.
import http from 'node:http';
import crypto from 'node:crypto';
import * as dk from '../index.ts';
import type { Services } from './context.ts';
import { runStartupMigrations } from './migrations.ts';
import { createModules, createRoutes, type Modules } from './modules.ts';
import { createRequestHandler, markStepUp } from './requests.ts';
import { logger } from '../src/logging.ts';

export interface ApplicationOptions extends Omit<Services, 'store'> {
  storeOptions: dk.StoreOptions;
}

// How long stop() waits for a running gate connection and its schedule, so a send isn't cut off before its check
// pull. Pulls take about 1.5-2 minutes; doorking.service's TimeoutStopSec (330 s) must stay longer.
const STOP_WAIT_MS = 5 * 60000;

export class Application {
  private store: dk.Store | null = null;
  private modules: Modules | null = null;
  private server: http.Server | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopping = false;
  private readonly options: ApplicationOptions;

  constructor(options: ApplicationOptions) {
    this.options = options;
  }

  // Opens the database, runs the one-time migrations, listens on server.port and starts the background work.
  async start(): Promise<void> {
    const { storeOptions, ...services } = this.options;
    this.store = await dk.openStore(storeOptions).catch((err: Error) => { throw new Error(`Database not available: ${err.message}`); });
    const modules = createModules({ ...services, store: this.store });
    this.modules = modules;
    const routes = createRoutes(modules);
    markStepUp(routes);
    await runStartupMigrations(modules);
    await this.offerFirstSetup(modules);
    this.server = http.createServer(createRequestHandler(modules, routes, () => this.stopping));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(modules.PORT, modules.HOST, () => resolve());
    });
    this.announce(modules);
    this.startBackgroundWork(modules);
  }

  // Refuses new requests, lets schedules start nothing new, waits up to STOP_WAIT_MS for the running gate connection
  // (and the schedule it belongs to), stops snapshot runs and camera bridges, and closes the database.
  async stop(reason = 'stop'): Promise<void> {
    const modules = this.modules;
    if (!modules || this.stopping) return;
    this.stopping = true;
    const running = modules.runningJobs().map((job) => `${job.what} of gate ${job.phoneNumber}`).join(', ');
    logger('server').info`${reason}: shutting down${running ? `, waiting for the running ${running}` : ''}`;
    for (const timer of this.timers) clearInterval(timer);
    modules.stopNewJobs();
    this.server?.close();
    this.server?.closeIdleConnections();
    modules.stopAllSnapshots();
    const until = Date.now() + STOP_WAIT_MS;
    while (!modules.jobsIdle() && Date.now() < until) await new Promise((r) => { setTimeout(r, 500); });
    if (!modules.jobsIdle()) {
      const still = modules.runningJobs().map((job) => `${job.what} of gate ${job.phoneNumber}`).join(', ');
      logger('server').warn`Stopped without waiting longer for the ${still || 'scheduled transfer'}`;
    }
    modules.cameras.stopAll();
    await dk.closeStore(this.store!).catch(modules.logged('server', 'Database not closed'));
  }

  // The port the server listens on (useful when the config asked for port 0).
  port(): number {
    return (this.server!.address() as import('node:net').AddressInfo).port;
  }

  // While no account exists, creating the first one needs a code printed only to the console (journalctl), so a
  // stranger reaching a fresh public install can't claim it first.
  private async offerFirstSetup(modules: Modules): Promise<void> {
    if (await dk.userCount(modules.store) !== 0) return;
    modules.setup.code = crypto.randomBytes(5).toString('hex');
    console.log(`No account exists yet. First-account setup code: ${modules.setup.code} (enter it on the page to create the first account, or run: node cli.ts create-admin <username>)`);
  }

  private announce(modules: Modules): void {
    const { config, PUBLIC_HOST, ROOT } = modules;
    console.log(`DoorKing web UI: http://localhost:${this.port()}${PUBLIC_HOST ? ` and https://${PUBLIC_HOST}` : ''}  (config ${config.file || 'none, defaults'}, media in ${ROOT})`);
    logger('server').info`Started on port ${this.port()}: ${JSON.stringify(dk.maskedConfig(config))}`;
  }

  private startBackgroundWork(modules: Modules): void {
    const { checkSchedules, logged, SCHEDULE_TICK_MS, sendEmails, SNAPSHOT_TIDY_MS, store, sweepSessions, tidyAllSnapshots } = modules;
    const tidy = () => { tidyAllSnapshots().catch(logged('camera', 'Snapshot clean-up failed')); };
    checkSchedules();
    sendEmails();
    tidy();
    this.timers = [
      setInterval(checkSchedules, SCHEDULE_TICK_MS),
      setInterval(sweepSessions, 60000),
      setInterval(sendEmails, 30000),
      setInterval(() => { dk.deleteExpiredTokens(store).catch(logged('session', 'Expired link clean-up failed')); }, 3600000),
      setInterval(tidy, SNAPSHOT_TIDY_MS),
    ];
  }
}
