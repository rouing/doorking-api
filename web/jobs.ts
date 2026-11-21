// Gate connections (one at a time per DKS account: DKS Cloud refuses a second session on the same login; gates on
// different logins run at the same time): pulls, sends, login checks, relay calls and scheduled transfers.
import crypto from 'node:crypto';
import { withContext } from '@logtape/logtape';
import * as dk from '../index.ts';
import type { BoardBuffers } from '../src/residents-edit.ts';
import type { RecordChange } from '../src/audit.ts';
import type { GateConfig, GateRole, Schedule } from '../src/types.ts';
import type { Gate, JobInfo, JobState, Reply, SessionRequest } from './context.ts';
import type { ContextModule } from './context.ts';
import type { EditingModule } from './editing.ts';
import type { MailModule } from './mail.ts';
import type { SnapshotsModule } from './snapshots.ts';
import { logger } from '../src/logging.ts';

type PreparedSend = Awaited<ReturnType<typeof dk.prepareSend>> & { counts: number[] };

export function createJobs(deps: ContextModule & EditingModule & MailModule & SnapshotsModule) {
  const { asGate, client, config, defaults, GATE_CONFIG_KEYS, gateAlert, logged, prefsOf, queueSnapshots, refuseDuplicates, scheduledSnapshots, serial, siteNameOf, store } = deps;
  const IDLE: JobState = { state: 'idle', log: [] };
  const jobs = new Map<string, JobState>(); // phone -> the gate's current or last connection
  const relayCalls = new Map<string, number>(); // DKS account -> live relay calls running on it
  // DKS logins are compared without case.
  const accountOf = (dksUser: unknown): string => String(dksUser ?? '').trim().toLowerCase();
  const currentJob = (phone: string): JobState => jobs.get(phone) || IDLE;
  // The running connection on a DKS account, if any.
  const runningOn = (account: string): JobState | undefined => [...jobs.values()].find((j) => j.state === 'running' && j.account === account);
  const accountBusy = (gate: Gate): boolean => Boolean(runningOn(accountOf(gate.user))) || Boolean(relayCalls.get(accountOf(gate.user)));
  // The gate a user is adding (its first pull), or null.
  const addingJobOf = (user: string): JobState | null =>
    [...jobs.values()].reverse().find((j) => j.adding && j.user === user) || null;
  // The gate-match config lives in the gate-scoped prefs (keyed by phone number), set under System Settings.
  async function sessionRequest(gate: Gate, what: string, extra: Record<string, unknown> = {}): Promise<SessionRequest> {
    if (!gate.user || !gate.password) throw new Error('This gate has no DKS login yet. A gate admin can set it in System Settings → Gate login.');
    const cfg: Partial<GateConfig> = (await prefsOf(gate.phoneNumber)).gateConfig || {};
    const chosen = Object.fromEntries(GATE_CONFIG_KEYS
      .filter((k) => typeof cfg[k] === 'string' && cfg[k].trim())
      .map((k) => [k, (cfg[k] as string).trim()]));
    return dk.buildSessionRequest(what, {
      ...defaults,
      ...chosen,
      ...extra,
      user: gate.user, password: gate.password, phoneNumber: gate.phoneNumber, masterCode: gate.masterCode,
    });
  }
  // Forgets the gate's last connection (its stored data was deleted).
  function forgetJob(phone: string): void {
    jobs.delete(phone);
  }
  // Starts a gate connection (its DKS account must be free, see busy): the job is claimed at once, then makeRequest() builds the DKS session request and
  // run(log, request) does the work. The job's state and log are read via GET .../job.
  // When it ends, it is recorded in the gate's history (info adds fields to that entry; scheduled: true marks a
  // scheduled transfer). Returns a promise of the finished job.
  function startJob(gate: Gate, what: string, makeRequest: () => Promise<SessionRequest>,
    run: (log: (line: string) => void, request: SessionRequest) => Promise<void>, info: JobInfo = {}): Promise<JobState> {
    const startedAt = new Date();
    const j: JobState = { state: 'running', what, phoneNumber: gate.phoneNumber, user: gate.actor, account: accountOf(gate.user), startedAt, log: [],
      ...(info.adding && { adding: true }) };
    jobs.set(gate.phoneNumber, j);
    // Each job line also goes to the server log (the job keeps the last MAX_JOB_LOG lines), except a status repeated while the gate is polled.
    let lastLine = '';
    const log = (line: string) => {
      j.log.push(`${new Date().toLocaleTimeString('en-US')}  ${line}`);
      if (j.log.length > MAX_JOB_LOG) j.log.shift(); // the page fetches the whole log every 3 s
      if (line !== lastLine) logger('gate')[line.startsWith('Error') ? 'error' : 'info']`Gate ${gate.phoneNumber}: ${line}`;
      lastLine = line;
    };
    // Every log line of the connection, here and in src/, carries its job id and gate (LogTape context).
    return withContext({ job: crypto.randomUUID().slice(0, 8), gate: gate.phoneNumber, what }, () => (async () => {
      const request = await makeRequest();
      log(`Starting ${info.scheduled ? 'scheduled ' : ''}${what === 'send' ? 'send' : `${what} pull`} by ${gate.actor}: ${JSON.stringify(dk.maskRequest(request, gate.user))}`);
      await run(log, request);
    })()
      .then(() => { j.state = 'done'; })
      .catch((err) => { log(`Error: ${err.message}`); j.state = 'failed'; j.error = err.message; })
      .then(async () => {
        const finishedAt = new Date();
        j.finishedAt = finishedAt;
        logger('gate').info`Gate ${gate.phoneNumber}: ${what} ${info.scheduled ? '(scheduled) ' : ''}${j.state} after ${Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)} s`;
        if (info.adding && !await finishAdding(gate, j, log)) return j;
        if (what === 'send' && j.state === 'failed' && !info.scheduled) {
          await gateAlert(gate.phoneNumber, 'Send to gate failed', `Started by ${gate.actor}. Error: ${j.error}`).catch(logged('email', 'Gate alert not sent'));
        }
        const { adding, ...rest } = info;
        const action = what === 'send' ? 'send' : 'pull';
        const summary = `${what === 'send' ? 'Sent working copy to gate' : `Pulled ${what}`}${info.scheduled ? ' (scheduled)' : ''}${adding ? ' (gate added)' : ''}`;
        try {
          await dk.addEvent(store, gate.phoneNumber, { user: gate.actor, action, what, summary, result: j.state, ...(j.error && { error: j.error }), ...rest });
        } catch (err) { logger('server').error`History not saved: ${(err as Error).message}`; }
        return j;
      }));
  }
  const roleText = (role: GateRole) => (role === 'admin' ? 'admin' : 'read only');
  // A new master code (with the DKS login): checked by a residents pull with it, and saved only when that succeeds.
  function startLoginCheck(gate: Gate): Promise<JobState> {
    return startPull(gate, 'residents').then(async (j) => {
      if (j.state !== 'done') return j;
      await dk.updateGateLogin(store, gate.phoneNumber, { masterCode: gate.masterCode, dksUser: gate.dksUser, dksPassword: gate.dksPassword });
      j.log.push(`${new Date().toLocaleTimeString('en-US')}  New master code saved`);
      await dk.addEvent(store, gate.phoneNumber, { user: gate.actor, action: 'login', summary: 'Changed the gate\'s master code' });
      logger('gates').info`${gate.actor} changed the master code of gate ${gate.phoneNumber}`;
      return j;
    });
  }
  // The first pull of a gate being added: on success the gate is saved with its DKS login and master code, and the
  // person adding it becomes its admin. On failure everything stored for that phone number (its gate configuration
  // and anything the pull left) is removed. Returns false when the gate was not added (nothing goes in its History).
  async function finishAdding(gate: Gate, j: JobState, log: (line: string) => void): Promise<boolean> {
    try {
      if (j.state === 'done') {
        await dk.registerGate(store, gate, gate.actor);
        log(`Gate added; ${gate.actor} is its admin`);
        logger('gates').info`${gate.actor} added gate ${gate.phoneNumber}`;
        return true;
      }
    } catch (err) { j.state = 'failed'; j.error = (err as Error).message; log(`Error: ${j.error}`); }
    if (!await dk.gateExists(store, gate.phoneNumber)) {
      try { await dk.deleteGateData(store, gate.phoneNumber); } catch (err) { logger('gates').error`Cleanup after a failed add of ${gate.phoneNumber}: ${(err as Error).message}`; }
    }
    logger('gates').warn`${gate.actor} could not add gate ${gate.phoneNumber}: ${j.error}`;
    return false;
  }
  const MAX_JOB_LOG = 500;
  // The board files of a pull, or null when one is missing.
  const boardOf = (files: Record<string, Buffer>): BoardBuffers | null => (dk.CACHE_FILES.every((file) => files[file])
    ? { names: files['names.bin'], phone: files['phone.bin'], cards: files['cards.bin'] } : null);
  // Runs the round-trip and rebuild checks on a pull (gate-state.ts; files: the pull, else the gate's stored files) and
  // records them. Returns a line for the job log.
  async function recordGateState(phone: string, files?: BoardBuffers | null): Promise<string> {
    const pulled = files === undefined ? await dk.readBaseFiles(store, phone) : files;
    if (!pulled) return 'Round-trip check skipped: the pull is missing a file';
    const prefs = await prefsOf(phone);
    const gate = await dk.getGate(store, phone);
    const check = await dk.checkPull(store, phone, pulled, new Date(),
      { areaCodeSlots: dk.areaCodeLimit((prefs.gateConfig || {}).areaCodes || defaults.areaCodes), masterCode: gate ? gate.masterCode : undefined });
    const line = (check.ok ? 'Round-trip check passed: the files rebuild byte for byte from their values'
      : `Round-trip check FAILED (editing stays locked): ${JSON.stringify(check.problems).slice(0, 500)}`)
      + (check.rebuild.ok ? '; rebuild from values alone passed' : `; rebuild from values alone differs: ${JSON.stringify(check.rebuild.problems).slice(0, 500)}`);
    logger('gate').info`Gate ${phone}: ${line}`;
    return line;
  }
  // Job log lines for what a residents pull did to the working copy (gate-cache.ts applyPull).
  function pullLines(r: dk.PullResult): string[] {
    const s = (n: number) => (n === 1 ? '' : 's');
    if (r.outcome === 'new') return ['Working copy made from this pull'];
    if (r.outcome === 'unchanged') return ['The gate holds the same data as before'];
    if (r.outcome === 'refreshed') return ['Working copy updated from this pull (it had no unsent changes)'];
    if (r.outcome === 'dropped') {
      return [`Your ${r.dropped!.count} unsent change${s(r.dropped!.count)} were dropped and the working copy now matches the gate: ${r.dropped!.reason}`];
    }
    return [
      `Working copy updated from this pull: ${r.fromGate} change${s(r.fromGate)} from the gate taken, ${r.kept} unsent change${s(r.kept)} kept on top`,
      ...(r.conflicts.length ? [`${r.conflicts.length} conflict${s(r.conflicts.length)} to decide before sending (changed differently at the gate and here): ${
      r.conflicts.map((conflict) => conflict.label).join('; ')}`] : []),
      ...r.notKept.map((n) => `Couldn't keep your change to ${n.label} (${n.error}); the gate's value is used`),
    ];
  }
  // Applies a residents pull to the working copy (no edit is saved meanwhile) and logs what happened.
  async function applyResidentsPull(gate: Gate, files: Record<string, Buffer>, log: (line: string) => void): Promise<void> {
    const r = await serial(gate.phoneNumber, () => dk.applyPull(store, gate.phoneNumber, files));
    for (const line of pullLines(r)) log(line);
  }
  function startPull(gate: Gate, what: dk.PullKind, info: JobInfo = {}): Promise<JobState> {
    const pulled = (j: JobState) => { if (what === 'transactions' && j.state === 'done' && !stopping) queueSnapshots(gate.phoneNumber, gate.dir); return j; };
    return startJob(gate, what, () => sessionRequest(gate, what), async (log, request) => {
      const { files } = await dk.pullFromGate(client(), what, request, { onStatus: log });
      for (const [f, data] of Object.entries(files)) log(`Read ${f} (${data.length} bytes)`);
      if (files['rcv_out.bin']) {
        const merged = await dk.mergeTransactions(store, gate.phoneNumber, files['rcv_out.bin']);
        log(`Transaction history: ${merged.added} new event${merged.added === 1 ? '' : 's'}, ${merged.kept} already saved`);
        if (merged.gap) log('No overlap with the saved history: events may be missing since the last pull, or the gate\'s buffer was cleared');
      }
      if (what === 'residents') {
        log(await recordGateState(gate.phoneNumber, boardOf(files)));
        await applyResidentsPull(gate, files, log);
      }
    }, info).then(pulled);
  }
  // Resident counts for the send session's UserID (DoorKing32 FUN_004f7320: records with FL 0, FL 2).
  // Derived from the working copy's names.bin directory, so no RESIDENT.DAT is needed.
  async function residentCounts(phone: string) {
    const { data } = await dk.readCacheFile(store, phone, 'names.bin'); // throws 404 "pull residents" if there is no working copy
    return dk.namesResidentCounts(data);
  }
  // Everything a send needs from the working copy; throws (409/404) when it can't be sent.
  async function prepareGateSend(gate: Gate): Promise<PreparedSend> {
    await refuseDuplicates(gate.phoneNumber);
    return { ...await dk.prepareSend(store, gate.phoneNumber), counts: await residentCounts(gate.phoneNumber) };
  }
  // Sends the working copy, then pulls residents again to check the gate now holds what was sent.
  // Match: the pull becomes the base and the working copy; edits saved while the send ran are kept on top of it (applied
  // like any residents pull). Mismatch: the pull is applied like any residents pull (the changes not on the gate stay
  // unsent) and the differing blocks are logged.
  // prepared: from prepareGateSend, awaited before the busy check so the job is claimed without a gap.
  function startSend(gate: Gate, prepared: PreparedSend, info: JobInfo = {}): Promise<JobState> {
    return startJob(gate, 'send', () => sessionRequest(gate, 'send', { residentCounts: prepared.counts }), async (log, request) => {
      const pullRequest = await sessionRequest(gate, 'residents');
      log(`Changed blocks: ${Object.entries(prepared.changedBlocks).map(([f, b]) => `${f} [${b.join(', ')}]`).join('; ')}`);
      await dk.pushToGate(client(), request, { files: prepared.files, maps: prepared.maps, onStatus: log });
      log('Send finished; pulling residents to check');
      const { files } = await dk.pullFromGate(client(), 'residents', pullRequest, { onStatus: log });
      log(await recordGateState(gate.phoneNumber, boardOf(files)));
      const check = await dk.verifySend(store, gate.phoneNumber, files, prepared.files);
      if (!check.matches) {
        await applyResidentsPull(gate, files, log);
        throw new Error(`Check pull differs from what was sent: ${JSON.stringify(check.differentBlocks)}. What the gate doesn't hold is still unsent.`);
      }
      const later = await serial(gate.phoneNumber, () => dk.acceptSentPull(store, gate.phoneNumber, files, prepared.files));
      const lines = later ? ['Check passed: the gate holds what was sent. Changes saved while sending:', ...pullLines(later)]
        : ['Check passed: the gate holds the working copy, which now matches the gate.'];
      for (const line of lines) log(line);
    }, {
      ...info,
      details: Object.entries(prepared.changedBlocks).filter(([, b]) => b.length)
        .map(([f, b]) => ({ key: f, label: f, change: 'sent' as RecordChange['change'], fields: [{ field: 'Blocks', from: '', to: b.join(', ') }] })),
    });
  }
  // Checked and acted on without awaiting in between, so two requests can't both start a connection on one account.
  const busy = (gate: Gate): Promise<Reply> | null => (accountBusy(gate)
    ? busyMessage(gate).then((error): Reply => [409, { error }]) : null);
  // Runs a live relay call (GetRelays/SetRelays) on the gate's DKS account; refused (409) while that account is busy.
  async function withAccount<T>(gate: Gate, fn: () => Promise<T>): Promise<T> {
    if (accountBusy(gate)) throw dk.httpError(await busyMessage(gate), 409);
    const account = accountOf(gate.user);
    relayCalls.set(account, (relayCalls.get(account) || 0) + 1);
    try {
      return await fn();
    } finally {
      relayCalls.set(account, relayCalls.get(account)! - 1);
      if (!relayCalls.get(account)) relayCalls.delete(account);
    }
  }
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const scheduleText = (schedule: Schedule) => `${schedule.enabled ? '' : 'off, '}${schedule.days.map((day) => DAY_NAMES[day]).join(' ')} ${schedule.time}: ${schedule.actions.join(', ')}`;
  // Scheduled transfers: checked every 30 s and once at startup, so a time missed while the server was stopped
  // runs once. Due entries queue up per DKS account and run one at a time on it, each transfer waiting until the
  // account is free; entries on different accounts run at the same time.
  const SCHEDULE_TICK_MS = config.schedules.checkSeconds * 1000;
  const scheduleQueue: { schedule: Schedule; account: string }[] = [];
  const runningSchedules = new Map<string, Schedule>(); // DKS account -> the entry running on it
  const isScheduleQueued = (id: string): boolean => scheduleQueue.some((queued) => queued.schedule.id === id)
    || [...runningSchedules.values()].some((schedule) => schedule.id === id);
  const scheduleRunningFor = (phone: string): boolean => [...runningSchedules.values()].some((schedule) => schedule.phoneNumber === phone);
  // Takes the gate's waiting entries off the queue (its stored data is being deleted).
  function dropQueuedSchedules(phone: string): void {
    for (let i = scheduleQueue.length - 1; i >= 0; i--) if (scheduleQueue[i].schedule.phoneNumber === phone) scheduleQueue.splice(i, 1);
  }
  const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });
  // Server shutdown: no schedule starts or runs another transfer; idle once every running connection and schedule end.
  let stopping = false;
  function stopNewJobs(): void { stopping = true; }
  const jobsIdle = (): boolean => ![...jobs.values()].some((j) => j.state === 'running') && !runningSchedules.size && !relayCalls.size;
  // The running connections (for the shutdown log).
  const runningJobs = (): JobState[] => [...jobs.values()].filter((j) => j.state === 'running');
  async function queueSchedule(sch: Schedule): Promise<boolean> {
    if (stopping || isScheduleQueued(sch.id)) return false;
    const rec = await dk.getGate(store, sch.phoneNumber);
    if (stopping || isScheduleQueued(sch.id)) return false; // queued while the gate was read
    scheduleQueue.push({ schedule: sch, account: accountOf(rec && rec.dksUser) });
    for (const { account } of scheduleQueue) if (!runningSchedules.has(account)) runAccountQueue(account);
    return true;
  }
  let checkingSchedules = false;
  async function checkSchedules() {
    if (checkingSchedules || stopping) return;
    checkingSchedules = true;
    const now = new Date();
    try {
      for (const sch of await dk.listSchedules(store)) {
        if (!dk.scheduleIsDue(sch, now)) continue;
        await dk.updateScheduleRun(store, sch.id, { lastDue: dk.lastDue(sch, now)!.toISOString() });
        await queueSchedule(sch);
      }
    } catch (err) { logger('schedule').error`Schedule check failed: ${(err as Error).message}`; }
    finally { checkingSchedules = false; }
  }
  // Runs the account's queued entries one after another.
  async function runAccountQueue(account: string) {
    if (runningSchedules.has(account)) return;
    for (let i = scheduleQueue.findIndex((queued) => queued.account === account); i >= 0 && !stopping;
      i = scheduleQueue.findIndex((queued) => queued.account === account)) {
      const [{ schedule }] = scheduleQueue.splice(i, 1);
      runningSchedules.set(account, schedule);
      try { await runSchedule(schedule); } finally { runningSchedules.delete(account); }
    }
  }
  // Runs an entry's transfers in SCHEDULE_ACTIONS order with the gate's DKS login. A failed transfer does
  // not stop the others; the entry's last result lists every error. Send is skipped when the working copy has
  // no changes. Snapshots do not use the gate connection.
  async function runSchedule(sch: Schedule) {
    const errors: string[] = [];
    const notes: string[] = [];
    const since = new Date();
    logger('schedule').info`Gate ${sch.phoneNumber}: schedule ${sch.id} started for ${sch.user} (${sch.actions.join(', ')})`;
    try {
      const rec = await dk.getGate(store, sch.phoneNumber);
      if (!rec) throw new Error('The gate is no longer managed here');
      const gate = asGate(rec, 'admin', sch.user);
      for (const what of dk.SCHEDULE_ACTIONS.filter((a) => sch.actions.includes(a))) {
        if (stopping) {
          errors.push(`${what}: not run, the server was stopping`);
          continue;
        }
        if (what === 'snapshots') {
          try {
            const { error, note } = await scheduledSnapshots(gate.phoneNumber, gate.dir, since);
            if (error) errors.push(`snapshots: ${error}`);
            if (note) notes.push(note);
          } catch (err) { errors.push(`snapshots: ${(err as Error).message}`); }
          continue;
        }
        try {
          if (what === 'send' && !(await dk.cacheStatus(store, gate.phoneNumber)).edited) { notes.push('Send skipped: no changes'); continue; }
          let prepared: PreparedSend | null = null;
          do {
            while (accountBusy(gate)) await sleep(2000);
            if (what === 'send') prepared = await prepareGateSend(gate);
          } while (accountBusy(gate)); // another connection started on the account while the send was being prepared
          if (stopping) throw new Error('not run, the server was stopping');
          const j = await (what === 'send' ? startSend(gate, prepared!, { scheduled: true }) : startPull(gate, what, { scheduled: true }));
          if (j.state === 'failed') errors.push(`${what}: ${j.error}`);
        } catch (err) { errors.push(`${what}: ${(err as Error).message}`); }
      }
    } catch (err) { errors.push((err as Error).message); }
    logger('schedule')[errors.length ? 'error' : 'info']`Gate ${sch.phoneNumber}: schedule ${sch.id} ${errors.length ? `failed: ${errors.join('; ')}` : 'done'}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    if (errors.length) {
      await gateAlert(sch.phoneNumber, 'Scheduled transfer failed', `Schedule ${sch.days.map((day) => DAY_NAMES[day]).join(' ')} ${sch.time} (${sch.actions.join(', ')}).\nErrors: ${errors.join('; ')}`).catch(logged('email', 'Gate alert not sent'));
    }
    try {
      await dk.updateScheduleRun(store, sch.id, {
        lastRun: new Date().toISOString(),
        lastResult: errors.length ? 'failed' : 'done',
        lastError: [...errors, ...notes].join('; ') || null,
      });
    } catch (err) { logger('schedule').error`Schedule result not saved: ${(err as Error).message}`; }
  }
  async function busyMessage(gate: Gate): Promise<string> {
    const running = runningOn(accountOf(gate.user));
    if (!running) return 'A live relay check is running on this gate\'s DKS login. Try again in a moment.';
    if (running.phoneNumber === gate.phoneNumber) return 'A gate connection is already running';
    const other = (await siteNameOf(running.phoneNumber)) || `the gate ending ${String(running.phoneNumber).slice(-4)}`;
    return `A gate connection is already running for ${other}, which uses the same DKS login`;
  }
  return { accountBusy, addingJobOf, currentJob, forgetJob, roleText, startLoginCheck, recordGateState, startPull, residentCounts, prepareGateSend, startSend, busy, withAccount,
    scheduleText, SCHEDULE_TICK_MS, isScheduleQueued, scheduleRunningFor, dropQueuedSchedules, stopNewJobs, jobsIdle, runningJobs, queueSchedule, checkSchedules };
}

export type JobsModule = ReturnType<typeof createJobs>;
