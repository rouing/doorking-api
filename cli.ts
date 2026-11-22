#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import * as dk from './index.ts';

const USAGE = `Usage: node cli.ts <command> [args] [--out <file>]

Local files (read-only):
  transactions <TRANSnnn.TRA>       Transaction log as CSV
  board <folder>                    Summary of names/phone/cards .bin and RCV_OUT.BIN
  phones <phone.bin>                phone.bin as CSV
  cards <cards.bin>                 cards.bin as CSV
  directory <names.bin>             names.bin directory as CSV
  rcvout <RCV_OUT.BIN>              Raw board transactions as CSV

DKS Cloud (read-only; credentials from DKS_USER / DKS_PASSWORD, URL from DKS_URL):
  cloud-login                       Check the login
  cloud-status <sessionId>          Show a session's status
  cloud-download <sessionId> <rcv_out.bin|names.bin|phone.bin|cards.bin>   Save a session file
  cloud-pull <transactions|residents> [--dir pulls] [--phone <sys phone>] [--site-name <tag>]
             [--memory 1000|2000|3000] [--area-codes 255|10] [--model 1834] [--marker <24 hex>]
             [--anti-passback Y|N] [--interface-1816 Y|N] [--dry-run]
                                    Start a session, read from the gate, download the files
                                    (master code from DKS_MASTER_CODE, system phone from --phone or DKS_PHONE)

Database (for whoever runs the server):
  db-setup [--test-db]              Create config.json's login role and database (and the tests' database with
                                    --test-db) through a PostgreSQL admin connection, then load sql/schema.sql and
                                    create the encryption key. Asks (hidden) for the admin connection URL, or reads
                                    DATABASE_ADMIN_URL. Safe to run again: existing roles, databases, tables are kept.

Accounts (for whoever runs the server; uses config.json's database; the password is asked for, not typed on the
command line):
  create-admin <username>           Create an account that becomes admin of every gate without an admin
  reset-password <username>         Set a temporary password (the user must choose a new one at sign-in)
  grant <username> <gate phone> <admin|readonly>   Give an account access to a gate (or change its role)
  test-email <address>              Send a test email now with config.json's email settings (shows the SMTP error, if any)
  sso-check                         Contact each single sign-on provider in config.json (sso.providers) and show the
                                    redirect address to register there
  emails                            The last 20 emails in the outbox (to, subject, status, error)

Web UI and REST API: node web/server.ts [--config config.json] [--check-config] [--port 8080] [--public-host <name>]
                           [--media media] [--logs logs]
                           [--site-name <tag>] [--memory 1000|2000|3000] [--area-codes "255 Area Codes"|"10 Area Codes"]
                           [--anti-passback Y|N] [--interface-1816 Y|N] [--model 1834]   (see README.md)`;

const csvCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const toCsv = (columns: [string, string][], rows: object[]): string => [columns.map((column) => column[0]),
  ...rows.map((row) => columns.map((column) => (row as Record<string, unknown>)[column[1]]))]
  .map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

// Area-code mode of a phone.bin, from the names.bin in the same folder (255 when there is none).
function phoneModeFor(file: string) {
  const dir = path.dirname(file);
  const names = fs.readdirSync(dir).find((name) => name.toLowerCase() === 'names.bin');
  return names ? dk.namesLayout(fs.readFileSync(path.join(dir, names))).areaCodeMode : 255;
}

function output(text: string, args: string[]) {
  const file = args[args.indexOf('--out') + 1];
  if (!args.includes('--out') || !file) {
    process.stdout.write(text);
    return;
  }
  fs.writeFileSync(file, text);
  console.error(`Wrote ${file}`);
}

function cloudClient() {
  return new dk.DksCloudClient({ url: process.env.DKS_URL || dk.DEFAULT_URL });
}

function credentials(): [string, string] {
  const { DKS_USER, DKS_PASSWORD } = process.env;
  if (!DKS_USER || !DKS_PASSWORD) throw new Error('Set DKS_USER and DKS_PASSWORD environment variables');
  return [DKS_USER, DKS_PASSWORD];
}

const serverConfig = () => dk.loadConfig({ args: process.argv.slice(2).filter((arg, i, all) => arg === '--config' || all[i - 1] === '--config') });

// The server's database (config.json).
async function openDatabase(): Promise<dk.Store> {
  const cfg = serverConfig();
  return dk.openStore({ connection: dk.connectionSettings(cfg.database), keyFile: cfg.paths.keyFile, poolSize: 1 });
}

// Reads a line from the terminal without showing it (or from standard input when that is not a terminal).
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => { data += chunk; });
      input.on('end', () => resolve(data.split(/\r?\n/)[0]));
      input.on('error', reject);
      return;
    }
    process.stderr.write(prompt);
    input.setRawMode(true);
    input.setEncoding('utf8');
    let text = '';
    const done = (value: string | null) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stderr.write('\n');
      if (value === null) {
        reject(new Error('Cancelled'));
        return;
      }
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(text);
        if (char === '\u0003') return done(null);
        text = char === '\u007f' || char === '\b' ? text.slice(0, -1) : text + char;
      }
    };
    input.on('data', onData);
    input.resume();
  });
}

// A new password, asked twice on a terminal.
async function newPassword(): Promise<string> {
  const password = await askHidden(`New password (at least ${dk.PASSWORD_MIN} characters): `);
  dk.checkPassword(password);
  if (process.stdin.isTTY && await askHidden('Again: ') !== password) throw new Error('The two passwords differ');
  return password;
}

async function withDatabase(fn: (store: dk.Store) => Promise<void>): Promise<void> {
  const store = await openDatabase();
  try { await fn(store); } finally { await dk.closeStore(store); }
}

const COMMANDS: Record<string, (positional: string[], args: string[]) => void | Promise<void>> = {
  'db-setup': async (_, args) => {
    const cfg = serverConfig();
    const login = dk.databaseLogin(cfg.database);
    const admin = process.env.DATABASE_ADMIN_URL
      || await askHidden('PostgreSQL admin connection URL (for example postgres://postgres:<password>@127.0.0.1:5432/postgres): ');
    if (!admin.trim()) throw new Error('No admin connection URL');
    const databases = [login.name, ...(args.includes('--test-db') ? [cfg.database.testName] : [])];
    for (const step of await dk.setupDatabase({ connectionString: admin.trim() }, { ...login, databases })) console.error(step);
    const hadKey = fs.existsSync(cfg.paths.keyFile);
    await withDatabase(async (store) => {
      const tables = await dk.all<{ n: number }>(store, "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = 'public'");
      console.error(`Schema: ${path.relative(process.cwd(), dk.SCHEMA_FILE)} loaded into ${login.name} as ${login.user} (${tables[0].n} tables)`);
    });
    console.error(`Encryption key: ${cfg.paths.keyFile} (${hadKey ? 'already there' : 'created; back it up with the database'})`);
  },

  'create-admin': ([username]) => withDatabase(async (store) => {
    if (!username) throw new Error('Usage: create-admin <username>');
    dk.checkUsername(username);
    if (await dk.getUser(store, username)) throw new Error(`The username "${dk.userKey(username)}" already exists`);
    const user = await dk.createUser(store, { username, password: await newPassword(), createdBy: 'cli', mustChangePassword: false });
    const gates = await dk.adoptAdminlessGates(store, user.username);
    console.error(`Created ${user.username}; admin of ${gates.length} gate(s)${gates.length ? `: ${gates.join(', ')}` : ''}`);
  }),

  'reset-password': ([username]) => withDatabase(async (store) => {
    if (!username) throw new Error('Usage: reset-password <username>');
    const user = await dk.getUser(store, username);
    if (!user) throw new Error(`There is no user "${dk.userKey(username)}"`);
    await dk.setPassword(store, user.username, await newPassword(), { mustChange: true });
    console.error(`Password of ${user.username} reset; they must choose a new one at their next sign-in. Their sessions were ended.`);
  }),

  'test-email': async ([to]) => {
    if (!to) throw new Error('Usage: test-email <address>');
    const cfg = serverConfig();
    const mailer = dk.createMailer(cfg.email);
    if (!mailer) throw new Error('Email is off: set email.host (and from, user, password) in config.json');
    await mailer.sendMail({ from: cfg.email.from, to, subject: 'DoorKing Gate Manager test email',
      text: `This is a test from DoorKing Gate Manager (${cfg.email.appUrl}). Email is working.` });
    console.error(`Sent to ${to} through ${cfg.email.host}:${cfg.email.port} (${cfg.email.security})`);
  },

  'sso-check': async () => {
    const cfg = serverConfig();
    if (!cfg.sso.providers.length) throw new Error('No single sign-on providers in config.json (sso.providers)');
    const origin = cfg.server.publicHost ? `https://${cfg.server.publicHost}` : `http://localhost:${cfg.server.port}`;
    let failed = 0;
    for (const provider of cfg.sso.providers) {
      console.log(`${provider.name} (${provider.id})`);
      console.log(`  redirect address to register: ${origin}/api/sso/${provider.id}/callback`);
      try {
        const metadata = await dk.discoverProvider(new dk.SsoFlows(), provider);
        console.log(`  issuer ${metadata.issuer}\n  sign-in page ${metadata.authorization}\n  token endpoint ${metadata.token}`);
        console.log(`  auth_time claim: ${metadata.authTime === null ? 'not listed (the provider lists no claims)' : metadata.authTime ? 'listed' : 'not listed in discovery (some providers still send it: check with a real sign-in)'}`
          + (provider.maxAgeHours ? `; sign-ins older than ${provider.maxAgeHours} hours are refused` : '; no session-age limit'));
      } catch (err) { failed++; console.log(`  NOT reachable: ${(err as Error).message}`); }
      console.log(`  allowed domains: ${provider.allowedDomains.join(', ') || 'none (invitations and linking only)'}; new accounts: ${provider.autoCreate ? 'yes' : 'no'}; passwords: ${provider.passwords ? 'allowed' : 'off'}`);
    }
    if (failed) process.exitCode = 1;
  },

  emails: () => withDatabase(async (store) => {
    for (const email of (await dk.listEmails(store, 20)).reverse()) {
      console.log(`${email.createdAt}  ${email.status.padEnd(6)}  ${email.kind.padEnd(8)}  ${email.to}  "${email.subject}"${email.error ? `  (${email.attempts} tries: ${email.error})` : ''}`);
    }
  }),

  grant: ([username, phone, role]) => withDatabase(async (store) => {
    if (!username || !phone || !role) throw new Error('Usage: grant <username> <gate phone> <admin|readonly>');
    const checked = dk.checkRole(role);
    if (!await dk.getGate(store, phone)) throw new Error(`Gate ${phone} is not managed here`);
    await (await dk.accessOf(store, phone, username) ? dk.setRole(store, phone, username, checked) : dk.grantAccess(store, phone, username, checked, 'cli'));
    console.error(`${dk.userKey(username)} is now ${checked} of gate ${dk.checkPhone(phone)}`);
  }),

  transactions: ([file], args) => output(toCsv([
    ['Timestamp', 'timestamp'], ['Date', 'date'], ['Time', 'time'], ['Type', 'type'],
    ['Code / Card', 'code'], ['Name', 'name'], ['Result', 'result'], ['Relay', 'relay'],
  ], dk.readTraFile(file).transactions), args),

  phones: ([file], args) => output(toCsv([
    ['Directory Code', 'directoryCode'], ['Area Code Index', 'areaCodeIndex'], ['Phone', 'phone'],
    ['Entry Code', 'entryCode'], ['Security Level', 'securityLevel'],
  ], dk.parsePhoneBin(fs.readFileSync(file), phoneModeFor(file))), args),

  cards: ([file], args) => output(toCsv([
    ['Card', 'cardNumber'], ['Directory Code', 'directoryCode'],
  ], dk.parseCardsBin(fs.readFileSync(file))), args),

  directory: ([file], args) => output(toCsv([
    ['Directory Code', 'directoryCode'], ['Name', 'name'], ['Flag', 'flag'],
  ], dk.parseNamesBin(fs.readFileSync(file)).directory), args),

  rcvout: ([file], args) => output(toCsv([
    ['Month', 'month'], ['Day', 'day'], ['Hour', 'hour'], ['Minute', 'minute'], ['PM', 'pm'],
    ['Event Flags', 'eventFlags'], ['Code Type', 'codeType'], ['Code', 'code'], ['Raw', 'raw'],
  ], dk.parseRcvOut(fs.readFileSync(file))), args),

  board: ([dir = '.'], args) => {
    const find = (name: string) => fs.readdirSync(dir).find((file) => file.toLowerCase() === name);
    const lines: string[] = [];
    const report = (name: string, fn: (b: Buffer) => string) => {
      const file = find(name);
      lines.push(file ? `${name.padEnd(12)} ${fn(fs.readFileSync(path.join(dir, file)))}` : `${name.padEnd(12)} (not found)`);
    };
    report('names.bin', (buffer) => `${dk.parseNamesBin(buffer).directory.length} directory entries`);
    report('phone.bin', (buffer) => `${dk.parsePhoneBin(buffer, phoneModeFor(path.join(dir, find('phone.bin')!))).filter((entry) => entry.phone).length} phone numbers`);
    report('cards.bin', (buffer) => `${dk.parseCardsBin(buffer).length} cards`);
    report('rcv_out.bin', (buffer) => `${dk.parseRcvOut(buffer).length} raw transactions`);
    for (const mapName of ['names.map', 'phone.map', 'cards.map']) {
      report(mapName, (buffer) => { const map = dk.parseMap(buffer); return `${map.changedBlocks.length} of ${map.blocks} blocks flagged`; });
    }
    output(`${lines.join('\r\n')}\r\n`, args);
  },

  'cloud-login': async (_, args) => output(`${await cloudClient().checkLogin(...credentials())}\n`, args),

  'cloud-status': async ([id], args) => output(`${await cloudClient().getSessionStatus(id)}\n`, args),

  'cloud-pull': async ([what], args) => {
    if (!['transactions', 'residents'].includes(what)) throw new Error(USAGE);
    const opt = (name: string, def?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
    const [user, password] = credentials();
    const masterCode = process.env.DKS_MASTER_CODE;
    if (!masterCode) throw new Error('Set DKS_MASTER_CODE (the account/master code)');
    const phoneNumber = opt('--phone', process.env.DKS_PHONE);
    if (!phoneNumber) throw new Error('Pass --phone <system phone> or set DKS_PHONE');
    const dir = opt('--dir', 'pulls')!;
    const request = dk.buildSessionRequest(what, {
      user,
      password,
      masterCode,
      phoneNumber,
      siteName: opt('--site-name', opt('--tag')),
      memorySize: opt('--memory'),
      areaCodes: opt('--area-codes'),
      dialDelay: opt('--dial-delay'),
      interface1816: opt('--interface-1816'),
      antiPassBack: opt('--anti-passback'),
      modelNumber: opt('--model'),
    });
    const marker = opt('--marker', dk.ZERO_MARKER);
    console.error('StartSessionSeries30', JSON.stringify(dk.maskRequest(request, user), null, 2));
    if (what === 'transactions') console.error(`ReceiveTransactionData TransactionBytes=${marker}`);
    if (args.includes('--dry-run')) return;

    const { files } = await dk.pullFromGate(cloudClient(), what as dk.PullKind, request, {
      marker, onStatus: (message) => console.error(message),
    });
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), data);
      console.error(`Wrote ${path.join(dir, name)} (${data.length} bytes)`);
    }
  },

  'cloud-download': async ([id, fileType], args) => {
    const data = await cloudClient().getDataFile(id, fileType);
    const i = args.indexOf('--out');
    const out = i >= 0 ? args[i + 1] : fileType;
    fs.writeFileSync(out, data);
    console.error(`Wrote ${out} (${data.length} bytes)`);
  },
};

async function main() {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  const positional = rest.filter((arg, i) => !['--out', '--config'].includes(arg) && !['--out', '--config'].includes(rest[i - 1]));
  if (!COMMANDS[command]) {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
  await COMMANDS[command](positional, args);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
