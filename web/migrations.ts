// One-time data migrations run at startup, before the server listens; each does nothing once done.
import * as dk from '../index.ts';
import type { Modules } from './modules.ts';
import { logger } from '../src/logging.ts';

export async function runStartupMigrations(deps: Modules): Promise<void> {
  const { recordGateState, ROOT, store } = deps;
  // Once: emails saved before confirmation links existed must be confirmed.
  const unconfirmed = await dk.unconfirmOldEmails(store);
  if (unconfirmed) logger('server').info`${unconfirmed} account email(s) now need confirming (User Settings)`;
  // Once: gates from the DKS sign-in era become managed gates; the first local account becomes their admin.
  const migrated = await dk.migrateToLocalAccounts(store);
  if (migrated && migrated.gates.length) {
    const note = `Moved ${migrated.gates.length} gate(s) to local accounts${migrated.noLogin.length
      ? `; set the DKS login in System Settings for ${migrated.noLogin.join(', ')}` : ''}`;
    logger('server').info`${note}`;
  }
  // Once: the board files kept on disk before gate_files move into the database (then their tables are filled).
  const movedFiles = await dk.importGateFiles(store, ROOT);
  if (movedFiles && Object.keys(movedFiles).length) {
    logger('server').info`Moved the gate files on disk into the database: ${JSON.stringify(movedFiles)}`;
    for (const phone of Object.keys(movedFiles)) logger('server').info`Gate ${phone}: ${await recordGateState(phone)}`;
  }
  // Once per gate: the stored rcv_out.bin is merged into the transaction history and deleted (tx-history.ts).
  for (const { phone, added } of await dk.migrateRcvOut(store)) {
    logger('server').info`Gate ${phone}: stored rcv_out.bin merged into the transaction history (${added} new) and deleted`;
  }
  // Once per gate: a working copy still stored as files becomes values (gate-state.ts).
  for (const phone of await dk.migrateWorkingFiles(store)) {
    logger('server').info`Gate ${phone}: working copy moved into the values tables`;
  }
  // Once per gate: a newer pull still kept apart (the old `pulled` copy) is applied to the working copy and removed.
  for (const { phone, outcome } of await dk.migratePulledCopies(store)) {
    logger('server').info`Gate ${phone}: separate pulled copy applied (${outcome}) and removed`;
  }
  // Values stored since a working copy was saved (settings, extra bytes, file sizes) are added.
  for (const phone of await dk.addMissingValues(store)) {
    logger('server').info`Gate ${phone}: newly stored values added to the values tables`;
  }
}
