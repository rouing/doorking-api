/**
 * @module src/pull-archive
 *
 * Point-in-time archive of residents pulls (encrypted `names.bin`, `phone.bin`, `cards.bin`). Keeps up to the newest
 * 50 distinct pulls per gate so admins can compare or restore the working copy to any historical pull.
 */
import crypto from 'node:crypto';
import { all, decryptBytes, encryptBytes, one, phoneDigits, run, transaction, type Store } from './db.ts';
import { parseCardsBin, parseNamesBin } from './board-files.ts';
import type { BoardBuffers } from './residents-edit.ts';
import type { PullArchiveEntry } from './types.ts';

export const MAX_ARCHIVED_PULLS = 50;

interface ArchiveMetaRow {
  id: number;
  pulled_at: string;
  actor: string;
  residents_count: number;
  cards_count: number;
}

interface ArchiveFullRow extends ArchiveMetaRow {
  names_bin: Buffer;
  phone_bin: Buffer;
  cards_bin: Buffer;
}

const fromRow = (row: ArchiveMetaRow): PullArchiveEntry => ({
  id: Number(row.id),
  pulledAt: row.pulled_at,
  actor: row.actor,
  residentsCount: row.residents_count,
  cardsCount: row.cards_count,
});

const buffersHash = (files: BoardBuffers): string =>
  crypto.createHash('sha256').update(files.names).update(files.phone).update(files.cards).digest('hex');

/**
 * Archives a pulled set of board files for `phone` unless the newest archived entry already has identical bytes.
 * Automatically prunes entries older than `MAX_ARCHIVED_PULLS`.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param files - Pulled board buffers (`names`, `phone`, `cards`).
 * @param options - Archive metadata.
 * @param options.actor - Username or actor that initiated the pull.
 * @param [options.at] - Pull timestamp (defaults to now).
 * @returns Promise resolving to the new `PullArchiveEntry`, or `null` when unchanged from the previous snapshot.
 */
export async function archivePull(
  store: Store,
  phone: string,
  files: BoardBuffers,
  { actor, at = new Date() }: { actor: string; at?: Date },
): Promise<PullArchiveEntry | null> {
  const phoneKey = phoneDigits(phone);
  const hash = buffersHash(files);
  return transaction(store, async (tx) => {
    const latest = await one<{ hash: string }>(tx, 'SELECT hash FROM gate_pull_archive WHERE phone = $1 ORDER BY id DESC LIMIT 1', [phoneKey]);
    if (latest && latest.hash === hash) return null;
    const residentsCount = parseNamesBin(files.names).directory.filter((entry) => entry.name.trim() !== '').length;
    const cardsCount = parseCardsBin(files.cards).length;
    const inserted = (await one<ArchiveMetaRow>(tx, `INSERT INTO gate_pull_archive
      (phone, pulled_at, actor, hash, residents_count, cards_count, names_bin, phone_bin, cards_bin)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, pulled_at, actor, residents_count, cards_count`,
    [phoneKey, at.toISOString(), actor, hash, residentsCount, cardsCount,
      encryptBytes(tx, files.names), encryptBytes(tx, files.phone), encryptBytes(tx, files.cards)]))!;
    await run(tx, `DELETE FROM gate_pull_archive WHERE phone = $1 AND id NOT IN (
      SELECT id FROM gate_pull_archive WHERE phone = $1 ORDER BY id DESC LIMIT $2
    )`, [phoneKey, MAX_ARCHIVED_PULLS]);
    return fromRow(inserted);
  });
}

/**
 * Lists archived residents pulls for a gate, newest first (metadata only).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `PullArchiveEntry[]`.
 */
export async function listPullArchive(store: Store, phone: string): Promise<PullArchiveEntry[]> {
  const rows = await all<ArchiveMetaRow>(store,
    'SELECT id, pulled_at, actor, residents_count, cards_count FROM gate_pull_archive WHERE phone = $1 ORDER BY id DESC',
    [phoneDigits(phone)]);
  return rows.map(fromRow);
}

/**
 * Loads and decrypts one archived residents pull for `phone`.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param id - Archived pull numeric ID.
 * @returns Promise resolving to `{ entry, files }`, or `null` when not found.
 */
export async function readPullArchive(store: Store, phone: string, id: number): Promise<{ entry: PullArchiveEntry; files: BoardBuffers } | null> {
  if (!Number.isInteger(id) || id < 1) return null;
  const row = await one<ArchiveFullRow>(store,
    'SELECT id, pulled_at, actor, residents_count, cards_count, names_bin, phone_bin, cards_bin FROM gate_pull_archive WHERE phone = $1 AND id = $2',
    [phoneDigits(phone), id]);
  if (!row) return null;
  return {
    entry: fromRow(row),
    files: {
      names: decryptBytes(store, row.names_bin),
      phone: decryptBytes(store, row.phone_bin),
      cards: decryptBytes(store, row.cards_bin),
    },
  };
}
