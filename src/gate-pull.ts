/**
 * @module src/gate-pull
 *
 * Gate sessions through DKS Cloud: start a session, request transactions or resident data (or send resident
 * data), wait for the gate to finish, download the files and always end the session.
 */
import type { DksCloudClient, SessionSeries30Params } from './dks-cloud.ts';

export type PullKind = 'transactions' | 'residents';
type Client = Pick<DksCloudClient, 'startSessionSeries30' | 'receiveTransactionData' | 'receiveResidentData'
  | 'waitForSession' | 'getDataFile' | 'endSession' | 'sendResidentData' | 'getRelays' | 'setRelays'>;
type WaitOptions = Parameters<DksCloudClient['waitForSession']>[1];
type OnStatus = (status: string) => void;

/**
 * The gate's settings a session is started with (blank or missing ones take GATE_DEFAULTS), its DKS login, and for a
 * send the resident counts.
 */
export type SessionOptions = Partial<Record<keyof typeof GATE_DEFAULTS, string | undefined>> & {
  user?: string; password?: string; masterCode?: string; phoneNumber?: string; residentCounts?: number[];
};

export interface RelayStatus { relay: number; code: string; state: string }

export interface RelayCredentials {
  user?: string; password?: string; phoneNumber?: string; masterCode?: string; comType?: string;
  attempts?: number; retryMs?: number; onStatus?: OnStatus;
}

export const PULL_FILES: Record<PullKind, string[]> = {
  transactions: ['rcv_out.bin'],
  residents: ['names.bin', 'phone.bin', 'cards.bin'],
};

export const GATE_DEFAULTS = {
  siteName: 'Site',
  memorySize: '3000',
  areaCodes: '255 Area Codes', // the default in the DoorKing 6.5 manual (1.2.12, 3.1.2)
  modelNumber: '1833/1835/1837/1838',
  antiPassBack: 'N',
  interface1816: 'N',
  dialDelay: '3',
};

export const MEMORY_SIZES = ['1000', '2000', '3000'];

export const ZERO_MARKER = '000000000000000000000000';

/** Communication types offered by DoorKing32. Only the DKS ones go through DKS Cloud. */
export const COM_TYPES = ['DKS Cellular', 'DKS Data over IP', 'DKS VoIP Voice + Data', 'IM Server Modem',
  'Modem-to-Modem', 'Network', 'RS232', 'Diagnostics'];
export const CLOUD_COM_TYPES = COM_TYPES.slice(0, 3);

/**
 * UserID suffix per session kind. A send carries two resident counts (DoorKing32 FUN_004f7320).
 *
 * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
 * @param residentCounts - `unknown` value.
 * @returns `string` result.
 * @throws Error when validation or the underlying operation fails.
 */
function sessionTag(what: string, residentCounts: unknown): string {
  if (what === 'transactions') return '-1,-2';
  if (what === 'residents') return '-1,-1';
  if (!Array.isArray(residentCounts) || residentCounts.length !== 2 || !residentCounts.every(Number.isInteger)) {
    throw new Error('A send needs residentCounts [a, b]');
  }
  return residentCounts.join(',');
}

/**
 * StartSessionSeries30 parameters. Relay holds are always 'NNN' (no relay held open).
 * what = 'transactions' | 'residents' (pulls) | 'send' (needs o.residentCounts).
 *
 * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
 * @param options - Optional settings.
 * @returns `SessionSeries30Params & { userId: string }` result.
 * @throws Error when validation or the underlying operation fails.
 */
export function buildSessionRequest(what: string, options: SessionOptions): SessionSeries30Params & { userId: string } {
  if (!PULL_FILES[what as PullKind] && what !== 'send') throw new Error('what must be "transactions", "residents" or "send"');
  for (const k of ['user', 'password', 'masterCode', 'phoneNumber'] as const) {
    if (!options[k]) throw new Error(`Missing ${k}`);
  }
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
  const gate: Record<string, string> = { ...GATE_DEFAULTS, ...given };
  if (!MEMORY_SIZES.includes(String(gate.memorySize))) {
    throw new Error(`System memory must be ${MEMORY_SIZES.join(', ')} (got "${gate.memorySize}")`);
  }
  return {
    userId: `${options.user}/6.5.b[${gate.siteName}]{${sessionTag(what, options.residentCounts)}}`,
    password: options.password,
    userTime: new Date().toLocaleString('en-US'),
    dialDelay: gate.dialDelay,
    masterCode: options.masterCode,
    memorySize: gate.memorySize,
    phoneNumber: options.phoneNumber,
    relay012Hold: 'NNN',
    interface1816: gate.interface1816,
    antiPassBack: gate.antiPassBack,
    modelNumber: gate.modelNumber,
    areaCodes: gate.areaCodes,
  };
}

/**
 * Copy of the request that is safe to print or log.
 *
 * @param request - `T` value.
 * @param [user] - Local account username (or actor name for audit logs).
 * @returns Operation result.
 */
export function maskRequest<T extends { userId: string }>(request: T, user?: string) {
  return {
    ...request,
    userId: user ? request.userId.split(user).join('<user>') : request.userId,
    password: '<hidden>',
    masterCode: '<hidden>',
  };
}

/**
 * Runs one pull. Returns { sessionId, status, files: { name: Buffer } }.
 *
 * @param client - DKS Cloud SOAP client instance.
 * @param what - Transfer kind (`residents`, `transactions`, `send`, or `snapshots`).
 * @param request - `SessionSeries30Params` value.
 * @param [options] - Options object.
 * @param [options.marker] - Marker.
 * @param [options.onStatus] - Callback receiving progress lines.
 * @param [options.waitOptions] - Wait options.
 * @returns Promise resolving to `{ sessionId: string; status: string; files: Record<string, Buffer> }`.
 * @throws Error when validation or the underlying operation fails.
 */
export async function pullFromGate(
  client: Client, what: PullKind, request: SessionSeries30Params,
  { marker = ZERO_MARKER, onStatus = () => {}, waitOptions }: { marker?: string; onStatus?: OnStatus; waitOptions?: WaitOptions } = {},
): Promise<{ sessionId: string; status: string; files: Record<string, Buffer> }> {
  const sessionId = String(await client.startSessionSeries30(request)).trim();
  if (!sessionId || /error|fail|invalid/i.test(sessionId)) throw new Error(`StartSessionSeries30: ${sessionId}`);
  onStatus(`Session ${sessionId}`);
  try {
    const reply = what === 'transactions'
      ? await client.receiveTransactionData(sessionId, marker)
      : await client.receiveResidentData(sessionId);
    onStatus(`Request reply: ${reply}`);
    const { status, success } = await client.waitForSession(sessionId, { ...waitOptions, onStatus });
    if (!success) throw new Error(`Session finished without success: ${status}`);
    const files: Record<string, Buffer> = {};
    for (const file of PULL_FILES[what]) files[file] = await client.getDataFile(sessionId, file);
    return { sessionId, status, files };
  } finally {
    onStatus(`EndSession: ${await client.endSession(sessionId).catch((error: Error) => error.message)}`);
  }
}

/**
 * SendResidentData reply check as in DoorKing32: "Error" is retried unless it says "already in progress".
 *
 * @param reply - Fastify reply object.
 * @returns True when the condition holds.
 */
export const sendAccepted = (reply: string): boolean => !/Error/.test(reply) || /already in progress/.test(reply);

/** What a send writes (files and their change maps) and how it waits and retries. */
export interface PushToGateOptions {
  files?: Record<string, Buffer>; maps?: Record<string, Buffer>; oldSendStamp?: string; onStatus?: OnStatus;
  waitOptions?: WaitOptions; attempts?: number; retryMs?: number;
}

/**
 * Sends the resident files to the gate (request from buildSessionRequest('send', ...)).
 * Up to `attempts` SendResidentData calls, then waits for the session. Returns { sessionId, status }.
 *
 * @param client - DKS Cloud SOAP client instance.
 * @param request - `SessionSeries30Params` value.
 * @param [options] - Options object.
 * @param [options.files] - Map of board filenames to binary buffers.
 * @param [options.maps] - Maps.
 * @param [options.oldSendStamp] - Old send stamp.
 * @param [options.onStatus] - Callback receiving progress lines.
 * @param [options.waitOptions] - Wait options.
 * @param [options.attempts] - Attempts.
 * @param [options.retryMs] - Retry ms.
 * @returns Promise resolving to `{ sessionId: string; status: string }`.
 * @throws Error when validation or the underlying operation fails.
 */
export async function pushToGate(client: Client, request: SessionSeries30Params, {
  files, maps, oldSendStamp = '', onStatus = () => {}, waitOptions, attempts = 5, retryMs = 1000,
}: PushToGateOptions = {}): Promise<{ sessionId: string; status: string }> {
  if (!files || !PULL_FILES.residents.every((resident) => Buffer.isBuffer(files[resident]))) {
    throw new Error(`A send needs ${PULL_FILES.residents.join(', ')}`);
  }
  const sessionId = String(await client.startSessionSeries30(request)).trim();
  if (!sessionId || /error|fail|invalid/i.test(sessionId)) throw new Error(`StartSessionSeries30: ${sessionId}`);
  onStatus(`Session ${sessionId}`);
  try {
    let reply: string;
    for (let i = 1; ; i++) {
      try {
        reply = String(await client.sendResidentData(sessionId, { files, maps, oldSendStamp }));
        onStatus(`SendResidentData reply: ${reply}`);
        if (sendAccepted(reply)) break;
      } catch (err) {
        reply = (err as Error).message;
        onStatus(`SendResidentData failed: ${reply}`);
      }
      if (i >= attempts) throw new Error(`SendResidentData not accepted after ${attempts} tries: ${reply}`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    const { status, success } = await client.waitForSession(sessionId, { ...waitOptions, onStatus });
    if (!success) throw new Error(`Session finished without success: ${status}`);
    return { sessionId, status };
  } finally {
    onStatus(`EndSession: ${await client.endSession(sessionId).catch((error: Error) => error.message)}`);
  }
}

/** GetRelays reply: 19 characters, one per relay 0-18 ('0' off, '1' on, '2' unknown), or "Error: ...". */
export const RELAY_COUNT = 19;
const RELAY_STATES: Record<string, string> = { 0: 'Off', 1: 'On', 2: 'Unknown' };

/**
 * Parse relay status.
 *
 * @param reply - Fastify reply object.
 * @returns `RelayStatus[]` result.
 * @throws Error when validation or the underlying operation fails.
 */
export function parseRelayStatus(reply: unknown): RelayStatus[] {
  const text = String(reply).trim();
  if (text.startsWith('Error:')) throw new Error(`GetRelays: ${text}`);
  if (text.length !== RELAY_COUNT) {
    throw new Error(`GetRelays: Error: String is ${text.length} bytes, should be ${RELAY_COUNT}.`);
  }
  return [...text].map((code, relay) => ({ relay, code, state: RELAY_STATES[code] || `Code ${code}` }));
}

/**
 * The DKS user id for relay calls, after checking the credentials are complete and the gate is reached through DKS
 * Cloud (what: 'check' or 'control', for the message).
 *
 * @param options - Options object.
 * @param options.user - Local account username (or actor name for audit logs).
 * @param options.password - Plain-text password.
 * @param options.phoneNumber - Gate system phone number (digits or formatted).
 * @param options.masterCode - 4-digit gate master code.
 * @param [options.comType] - Com type.
 * @param what - 'check' or 'control', for the message.
 * @returns `string` result.
 * @throws Error when validation or the underlying operation fails.
 */
function relayUserId({ user, password, phoneNumber, masterCode, comType = 'DKS Cellular' }: RelayCredentials, what: string): string {
  for (const [key, value] of Object.entries({ user, password, phoneNumber, masterCode })) {
    if (!value) throw new Error(`Missing ${key}`);
  }
  if (!CLOUD_COM_TYPES.includes(comType)) throw new Error(`Relay ${what} through DKS Cloud needs a DKS communication type, not "${comType}"`);
  return `${user}${comType === 'DKS Cellular' ? '/cellular' : '/client'}`;
}

/**
 * Instant relay status check (no session, nothing is changed on the gate).
 *
 * @param client - DKS Cloud SOAP client instance.
 * @param cred - `RelayCredentials` value.
 * @returns Promise resolving to `RelayStatus[]`.
 */
export async function checkRelays(client: Pick<Client, 'getRelays'>, cred: RelayCredentials): Promise<RelayStatus[]> {
  return parseRelayStatus(await client.getRelays(relayUserId(cred, 'check'), cred.password, cred.phoneNumber, cred.masterCode));
}

/**
 * Live relay control (SetRelays). `desired` maps a relay index (0-18) to a boolean (true = Active/Hold = gate held open).
 * Reads the current state first and echoes every untouched relay unchanged, so only the named relays move.
 * Returns { before, settings, reply, after }. A no-op (desired matching current) is a safe way to confirm the format.
 *
 * @param client - DKS Cloud SOAP client instance.
 * @param cred - `RelayCredentials` value.
 * @param desired - Map of relay numbers to desired active state (`true` = held open).
 * @returns Promise resolving to `{ before: RelayStatus[]; settings: string; reply: string; after: RelayStatus[] }`.
 * @throws Error when validation or the underlying operation fails.
 */
export async function controlRelays(
  client: Pick<Client, 'getRelays' | 'setRelays'>, cred: RelayCredentials, desired: Record<number, boolean>,
): Promise<{ before: RelayStatus[]; settings: string; reply: string; after: RelayStatus[] }> {
  const { password, phoneNumber, masterCode } = cred;
  const userId = relayUserId(cred, 'control');
  const before = parseRelayStatus(await client.getRelays(userId, password, phoneNumber, masterCode));
  /**
   * SetRelays wants a 20-char Settings string: a leading mode letter + 19 relay states (DoorKing32 FUN_004f3dd0).
   * The mode letter (FUN_004f1c20) depends on which relay banks change vs the current state: positions 3-10 and 11-18.
   *   both banks unchanged -> M ; only 3-10 changed -> R ; only 11-18 changed -> P ; both changed -> T.
   * FUN_004f1c20 compares the banks as they are: a relay left alone keeps its code (also '2') on both sides, so it
   * never counts as a change. States are the desired 19 chars; '2' (unknown) is sent as '0' (FUN_004f3c40 replaces
   * '2' with '0').
   */
  const cur = before.map((relay) => relay.code).join('');
  const wanted = before.map((relay) => (relay.relay in desired ? (desired[relay.relay] ? '1' : '0') : relay.code)).join('');
  const des = wanted.replaceAll('2', '0');
  const bank = (codes: string, start: number) => codes.slice(start, start + 8);
  const bank1Same = bank(cur, 3) === bank(wanted, 3); // relays 3-10 unchanged
  const bank2Same = bank(cur, 11) === bank(wanted, 11); // relays 11-18 unchanged
  const mode = bank2Same ? (bank1Same ? 'M' : 'R') : (bank1Same ? 'P' : 'T');
  const settings = mode + des;
  /** DKS reaching the gate over cellular can time out; retry the same (idempotent) command a few times. */
  const { attempts = 4, retryMs = 2500, onStatus = () => {} } = cred;
  let reply: string;
  for (let i = 1; ; i++) {
    reply = String(await client.setRelays(userId, password, phoneNumber, masterCode, settings)).trim();
    if (!/^error/i.test(reply)) break;
    onStatus(`SetRelays attempt ${i}: ${reply}`);
    if (i >= attempts) throw new Error(`SetRelays failed after ${i} tries: ${reply}`);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  const after = parseRelayStatus(await client.getRelays(userId, password, phoneNumber, masterCode));
  return { before, settings, reply, after };
}
