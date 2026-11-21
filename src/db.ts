// Database: PostgreSQL through the pg driver, connected as config.json says (config.ts), with the encryption key in
// its own file (paths.keyFile, created on first use). The database holds the gate lists, gate-scoped prefs,
// sign-ins, history, saved DKS passwords, scheduled transfers, camera settings, the snapshot log, resident/vendor
// notes, the transaction history and the gate files. Master codes, passwords and the gate files are encrypted with
// AES-256-GCM using the key; anyone with the key and the database can decrypt them, so the key file must stay
// private and never be committed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { checkPrivate } from './config.ts';
import { logger } from './logging.ts';

// Gates are keyed by the digits of their phone number.
export const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');

// Timestamps come back as ISO strings (as stored before), bigints (COUNT, identities) as numbers.
const parseTimestamptz = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v: string) => (parseTimestamptz(v) as Date).toISOString());
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export interface Queryable { query(text: string, values?: unknown[]): Promise<pg.QueryResult> }
// db: the pool, or inside transaction() the transaction's client.
export interface Store { id: string; pool: pg.Pool; db: Queryable; key: Buffer; schema: string }

// The schema (tables, indexes), applied every time a store opens; every statement is idempotent.
export const SCHEMA_FILE = fileURLToPath(new URL('../sql/schema.sql', import.meta.url));
const SCHEMA = fs.readFileSync(SCHEMA_FILE, 'utf8');

const stores = new Map<string, Promise<Store>>(); // key file + connection + schema -> store

// The key from keyFile (64 hex digits), created when missing.
function readKey(file: string): Buffer {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  checkPrivate(file);
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  if (key.length !== 32) throw new Error(`${file} is not a valid key (64 hex digits)`);
  return key;
}

export interface StoreOptions {
  connection: pg.PoolConfig; // from connectionSettings (config.ts)
  keyFile: string;
  schema?: string; // a separate schema (tests use one per store)
  poolSize?: number;
}

async function connect(id: string, { connection, keyFile, schema = 'public', poolSize = 5 }: StoreOptions): Promise<Store> {
  const key = readKey(keyFile);
  const pool = new pg.Pool({ ...connection, max: poolSize, ...(schema !== 'public' && { options: `-c search_path=${schema}` }) });
  // An idle connection that fails (PostgreSQL restarted, network lost) is reported here; unhandled, it ends the process.
  // The pool drops that connection and opens a new one when next needed.
  pool.on('error', (error) => logger('server').error`Database connection lost: ${error.message}`);
  try {
    if (schema !== 'public') await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(SCHEMA);
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
  return { id, pool, db: pool, key, schema };
}

// Opens the database (creating the key and the tables when missing). The same key file, connection and schema
// always return the same store.
export function openStore(opts: StoreOptions): Promise<Store> {
  const schema = opts.schema || 'public';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name ${schema}`);
  const keyFile = path.resolve(opts.keyFile);
  const id = `${keyFile}|${JSON.stringify(opts.connection)}|${schema}`;
  if (!stores.has(id)) {
    const p = connect(id, { ...opts, keyFile, schema });
    p.catch(() => stores.delete(id));
    stores.set(id, p);
  }
  return stores.get(id)!;
}

export async function closeStore(store: Store): Promise<void> {
  stores.delete(store.id);
  await store.pool.end();
}

export async function all<T>(store: Store, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await store.db.query(sql, params)).rows as T[];
}

export async function one<T>(store: Store, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await store.db.query(sql, params)).rows[0] as T | undefined;
}

// Runs a statement; returns the number of rows it changed.
export async function run(store: Store, sql: string, params: unknown[] = []): Promise<number> {
  return (await store.db.query(sql, params)).rowCount ?? 0;
}

// Runs fn inside one transaction; fn gets a store whose queries use the transaction.
export async function transaction<T>(store: Store, fn: (tx: Store) => Promise<T>): Promise<T> {
  if (store.db !== store.pool) return fn(store);
  const client = await store.pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn({ ...store, db: client });
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// "v1:<iv>:<tag>:<ciphertext>", base64 parts.
export function encrypt(store: Store, text: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', store.key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64') : p)).join(':');
}

// Bytes: 12-byte IV, 16-byte tag, then the ciphertext.
export function encryptBytes(store: Store, data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', store.key, iv);
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), out]);
}

export function decryptBytes(store: Store, data: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', store.key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}

export function decrypt(store: Store, value: unknown): string {
  const [v, iv, tag, data] = String(value).split(':');
  if (v !== 'v1' || data === undefined) throw new Error('Not an encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', store.key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export async function getMeta(store: Store, key: string): Promise<string | null> {
  const row = await one<{ value: string }>(store, 'SELECT value FROM meta WHERE key = $1', [key]);
  return row ? row.value : null;
}

export async function setMeta(store: Store, key: string, value: unknown): Promise<void> {
  await run(store, 'INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, String(value)]);
}

// The app's login role: created with its password when missing (an existing role keeps its password).
async function ensureRole(client: pg.Client, user: string, password: string): Promise<string> {
  if ((await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount) return `Login role ${user}: already exists (password left unchanged)`;
  if (!password) throw new Error(`No password for the new login role ${user}: set database.password in config.json`);
  await client.query(`CREATE ROLE ${client.escapeIdentifier(user)} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
  return `Login role ${user}: created`;
}

// A database owned by user: created when missing and closed to other logins (an existing one is left alone).
async function ensureDatabase(client: pg.Client, admin: pg.ClientConfig, database: string, user: string): Promise<string> {
  const id = (n: string) => client.escapeIdentifier(n);
  const existing = await client.query<{ owner: string }>('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [database]);
  if (existing.rowCount) {
    const owner = existing.rows[0].owner;
    return `Database ${database}: already exists, owned by ${owner}${owner === user ? '' : ` (not ${user}: it may not be allowed to create tables there)`}`;
  }
  await client.query(`CREATE DATABASE ${id(database)} OWNER ${id(user)}`);
  await client.query(`REVOKE ALL ON DATABASE ${id(database)} FROM PUBLIC`);
  // In the new database: only the app's login may use its public schema.
  const inDb = new pg.Client(admin.connectionString
    ? { ...admin, connectionString: Object.assign(new URL(admin.connectionString), { pathname: `/${database}` }).toString() }
    : { ...admin, database: database });
  await inDb.connect();
  try {
    await inDb.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO ${id(user)}`);
  } finally {
    await inDb.end().catch(() => {});
  }
  return `Database ${database}: created, owned by ${user}, closed to other logins`;
}

// Creates the app's login role (LOGIN, with its password) and databases, each owned by that role, through an admin
// connection (a superuser, or a role with CREATEROLE and CREATEDB). New databases are closed to other logins (no
// PUBLIC access to the database or its public schema). What already exists is left alone: an existing role keeps
// its password, an existing database its owner and permissions. Returns one line per step. The tables come from SCHEMA_FILE when the app opens the database.
export async function setupDatabase(admin: pg.ClientConfig, { user, password, databases }:
  { user: string; password: string; databases: string[] }): Promise<string[]> {
  for (const n of [user, ...databases]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(n)) throw new Error(`Invalid name "${n}": use lower-case letters, digits and _ (starting with a letter or _)`);
  }
  const client = new pg.Client(admin);
  await client.connect();
  const steps: string[] = [];
  try {
    const id = (n: string) => client.escapeIdentifier(n);
    steps.push(await ensureRole(client, user, password));
    // A non-superuser admin (CREATEROLE) holds only ADMIN over roles it creates (PostgreSQL 16+); giving a database
    // to a role needs the right to SET ROLE to it, which ADMIN lets it grant itself.
    const canSet = async () => (await client.query<{ ok: boolean }>(`SELECT rolsuper OR pg_has_role(current_user, $1, 'SET') AS ok
      FROM pg_roles WHERE rolname = current_user`, [user]).catch(() => client.query<{ ok: boolean }>(
      "SELECT rolsuper OR pg_has_role(current_user, $1, 'MEMBER') AS ok FROM pg_roles WHERE rolname = current_user", [user]))).rows[0]?.ok;
    if (databases.length && !await canSet()) {
      await client.query(`GRANT ${id(user)} TO CURRENT_USER`);
      steps.push(`Admin connection: made a member of ${user} (needed to make it the owner of new databases)`);
    }
    for (const database of databases) steps.push(await ensureDatabase(client, admin, database, user));
  } finally {
    await client.end().catch(() => {});
  }
  return steps;
}
