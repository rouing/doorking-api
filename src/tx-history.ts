// Transaction history: every event ever pulled from a gate, oldest first, in the database's tx_history table.
// A transactions pull reads the gate's whole ring buffer (rcv_out.bin), which drops its oldest events as new ones
// arrive. Like DoorKing32's TRANS files, the history keeps them: each pull is matched against the saved tail and
// only the events after the overlap are added. Records keep the year inferred when they were first saved (the
// board stores no year). The pulled rcv_out.bin itself isn't kept; tx_pulls records when the gate was last read.
import { all, decryptBytes, one, run, transaction, type Store, phoneDigits } from './db.ts';
import { orderRcvOut, parseRcvOut, type RcvRecord } from './board-files.ts';

export interface TxMerge { added: number; kept: number; gap: boolean }

const valid = (record: RcvRecord) => record.month >= 1 && record.month <= 12 && record.day >= 1 && record.day <= 31;

export async function txHistoryCount(store: Store, phone: unknown): Promise<number> {
  const row = await one<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM tx_history WHERE phone = $1', [phoneDigits(phone)]);
  return row!.n;
}

// Adds a pulled rcv_out.bin to the gate's history and records pulledAt as its last transactions pull. The pull starts
// with the oldest events still on the gate, so the longest run at the end of the saved history that equals the start
// of the pull is the overlap (kept); the rest is added. gap: nothing overlapped although history existed, so events
// may be missing between the two (the buffer wrapped past the last pull) or the gate's buffer was cleared.
export async function mergeTransactions(store: Store, phone: unknown, buf: Buffer, pulledAt: Date = new Date()): Promise<TxMerge> {
  const phoneKey = phoneDigits(phone);
  const pulled = orderRcvOut(buf, pulledAt).filter(valid);
  return transaction(store, async (tx) => {
    // One merge per gate at a time: the lock is held until the transaction ends.
    await one(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [`tx_history:${phoneKey}`]);
    const tail = (await all<{ raw: string }>(tx, 'SELECT raw FROM tx_history WHERE phone = $1 ORDER BY seq DESC LIMIT $2',
      [phoneKey, pulled.length])).map((r) => r.raw).reverse();
    let kept = 0;
    for (let i = 0; i < tail.length && !kept; i++) {
      const n = tail.length - i;
      let j = 0;
      while (j < n && tail[i + j] === pulled[j].raw) j++;
      if (j === n) kept = n;
    }
    const fresh = pulled.slice(kept);
    const last = await one<{ seq: number | null }>(tx, 'SELECT MAX(seq) AS seq FROM tx_history WHERE phone = $1', [phoneKey]);
    const at = new Date().toISOString();
    const first = (last!.seq ?? 0) + 1;
    for (let i = 0; i < fresh.length; i += 1000) {
      const part = fresh.slice(i, i + 1000);
      await run(tx, `INSERT INTO tx_history (phone, seq, raw, year, added_at)
        SELECT $1::text, s, r, y, $2::timestamptz FROM unnest($3::int[], $4::text[], $5::int[]) AS t(s, r, y)`,
      [phoneKey, at, part.map((_, j) => first + i + j), part.map((record) => record.raw), part.map((record) => record.year as number)]);
    }
    await run(tx, `INSERT INTO tx_pulls (phone, pulled_at) VALUES ($1, $2)
      ON CONFLICT (phone) DO UPDATE SET pulled_at = GREATEST(tx_pulls.pulled_at, excluded.pulled_at)`, [phoneKey, pulledAt.toISOString()]);
    return { added: fresh.length, kept, gap: tail.length > 0 && kept === 0 && pulled.length > 0 };
  });
}

// When the gate's transactions were last pulled, or null.
export async function txPulledAt(store: Store, phone: unknown): Promise<Date | null> {
  const r = await one<{ pulled_at: string }>(store, 'SELECT pulled_at FROM tx_pulls WHERE phone = $1', [phoneDigits(phone)]);
  return r ? new Date(r.pulled_at) : null;
}

// Once: each rcv_out.bin kept in gate_files (until 2026-11-13) is merged into the history as after a pull (events
// already saved are kept, not added again), its pull time recorded, and the file deleted. Returns { phone, added }.
export async function migrateRcvOut(store: Store): Promise<{ phone: string; added: number }[]> {
  const out: { phone: string; added: number }[] = [];
  const rows = await all<{ phone: string; data: Buffer; saved_at: string }>(store,
    "SELECT phone, data, saved_at FROM gate_files WHERE copy = 'pulled' AND name = 'rcv_out.bin' ORDER BY phone");
  for (const row of rows) {
    await transaction(store, async (tx) => {
      const merged = await mergeTransactions(tx, row.phone, decryptBytes(store, row.data), new Date(row.saved_at));
      await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'pulled' AND name = 'rcv_out.bin'", [row.phone]);
      out.push({ phone: row.phone, added: merged.added });
    });
  }
  return out;
}

// A page of the saved transactions: the newest `limit` (all when not given) older than seq `before`, oldest first, and
// next: the `before` that asks for the page older than this one (null when there is none).
export async function readTransactionPage(store: Store, phone: unknown, { before, limit }: { before?: number; limit?: number } = {}):
  Promise<{ records: RcvRecord[]; next: number | null }> {
  const rows = await all<{ raw: string; year: number; seq: number }>(store,
    'SELECT raw, year, seq FROM tx_history WHERE phone = $1 AND ($2::integer IS NULL OR seq < $2) ORDER BY seq DESC LIMIT $3',
    [phoneDigits(phone), before ?? null, limit ? limit + 1 : null]);
  const more = Boolean(limit) && rows.length > limit!;
  if (more) rows.pop();
  rows.reverse();
  return { records: rows.map((row) => ({ ...parseRcvOut(Buffer.from(row.raw, 'hex'))[0], year: row.year })), next: more ? rows[0].seq : null };
}

