import { Fragment, useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Callout, Card, Dialog, Flex, Heading, IconButton, Link, Table, Text, TextField } from '@radix-ui/themes';
import type { DeviceRange, EntryChange, GateFeatures, ResidentRow, ResidentsReply, TransactionRow } from '../../../src/types.ts';
import { dirCell, doorKingCsv, downloadText, fmtTime, isEmptySlot, txTone } from '../format.ts';
import { MAX_ROWS, nextSort, SortHead, sortRows, type Column, type Sort } from '../table.tsx';
import { CardList } from './fields.tsx';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';
import { ResidentForm } from './ResidentForm.tsx';
import { TX_COLUMNS } from './Transactions.tsx';
import { ACTIONS } from './History.tsx';
import { WorkingCopyBar } from './WorkingCopyBar.tsx';
import { errorText, useReadOnly, type GateApi } from '../api.ts';

const COLUMNS: Record<'residents' | 'vendors', Column[]> = {
  residents: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Hidden', 'hidden'], ['Phone', 'phoneFull'],
    ['Entry Code', 'entryCode'], ['Security', 'securityLevel'], ['Floor', 'floor'], ['Elevator', 'elevatorRef'], ['Cards', 'cards'],
    ['Notes', 'note']],
  vendors: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Entry Code', 'entryCode'], ['Security', 'securityLevel'],
    ['Cards', 'cards'], ['Notes', 'note']],
};
const HISTORY_COLUMNS = TX_COLUMNS.filter(([, k]) => k !== 'name' && k !== 'directoryCode');

// Residents or vendors in the working copy. Clicking a row shows its last 5 transactions and an Edit button;
// Add opens a form for a new entry.
export function Directory({ kind, account, list, tx, devices, features, snaps, onOpenSnap, highlight, gapi, onReload, onJobStarted }: {
  kind: 'residents' | 'vendors';
  account: string; // the site name, the export's ACCOUNT column
  list: ResidentsReply | null;
  tx: TransactionRow[] | null;
  devices: DeviceRange[];
  features: GateFeatures;
  snaps: Snaps;
  onOpenSnap: (t: TransactionRow) => void;
  highlight: string | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
  onJobStarted: () => void;
}) {
  const cols = COLUMNS[kind].filter(([, k]) => (k !== 'floor' || features.floors) && (k !== 'elevatorRef' || features.elevators));
  const vendor = kind === 'vendors';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const [open, setOpen] = useState<string | null>(highlight);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const readOnly = useReadOnly();

  useEffect(() => {
    setOpen(highlight);
    setEditing(false);
    if (!highlight) return;
    setFilter('');
    requestAnimationFrame(() => document.querySelector(`[data-code="${highlight}"]`)?.scrollIntoView({ block: 'center' }));
  }, [highlight]);

  const rows = useMemo(() => {
    let out = (list ? list.rows : []).filter((r) => (r.type === 'Vendor') === (kind === 'vendors') && !isEmptySlot(r));
    const q = filter.trim().toLowerCase();
    if (q) out = out.filter((r) => [...Object.values(r), dirCell(r, 'securityLevel')].join(' ').toLowerCase().includes(q));
    return sortRows(out, sort, (col) => (r: ResidentRow) => dirCell(r, col));
  }, [list, kind, filter, sort]);
  // Values held by more than one entry (all kinds, so a clash between a resident and a vendor shows on both pages).
  const dups = useMemo(() => {
    const of = (kindOf: string) => new Set((list?.duplicates || []).filter((d) => d.kind === kindOf).map((d) => d.value));
    return { directoryCode: of('directoryCode'), entryCode: of('entryCode'), card: of('card') };
  }, [list]);
  const dupCell = (r: ResidentRow, k: string) => (k === 'directoryCode' && dups.directoryCode.has(r.directoryCode))
    || (k === 'entryCode' && Boolean(r.entryCode) && dups.entryCode.has(r.entryCode));

  // Every directory code (residents, vendors and empty slots), in DoorKing's cloud export format.
  const csv = () => list && downloadText('ResidentsExport.csv', doorKingCsv(account, list.rows || [], list.unassignedCards));

  return (
    <Flex direction="column" gap="3">
      <Heading>{kind === 'vendors' ? 'Vendors' : 'Residents'}</Heading>
      <WorkingCopyBar cache={list ? list.cache : null} gapi={gapi} onReload={onReload} onJobStarted={onJobStarted} />
      {list && list.duplicates.length > 0 && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            <strong>Duplicate {list.duplicates.length === 1 ? 'number' : 'numbers'}: two or more entries share a directory code, entry code or card.</strong>{' '}
            The gate can't tell them apart, so <strong>Send to gate is refused</strong> until each is changed or removed (marked red below).
          </Callout.Text>
          <Box asChild><ul style={{ margin: 0 }}>{list.duplicates.map((d) => <li key={`${d.kind}-${d.value}`}>{d.text}</li>)}</ul></Box>
        </Callout.Root>
      )}
      {adding && list && (
        <Card>
          <ResidentForm r={null} vendor={vendor} dirDigits={list.dirDigits} emptyCodes={list.emptyCodes} devices={devices}
            features={features} gapi={gapi} onDone={async () => { setAdding(false); await onReload(); }} onCancel={() => setAdding(false)} />
        </Card>
      )}
      <Flex gap="3" align="center" wrap="wrap">
        {!readOnly && <Button onClick={() => setAdding(!adding)} disabled={!list}>{vendor ? 'Add vendor' : 'Add resident'}</Button>}
        <TextField.Root type="search" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button variant="soft" onClick={csv} disabled={!list} title="Every directory code (residents, vendors and empty units), in the format DoorKing's cloud exports">Export CSV</Button>
        <Text size="2" color="gray">
          {!list ? 'No data yet. Pull residents from the gate.'
            : `${rows.length} ${kind}${rows.length > MAX_ROWS ? ` (first ${MAX_ROWS} shown)` : ''} · downloaded ${fmtTime(list.updated)}`
              + (kind === 'residents' && list.unassignedCards.length ? ` · ${list.unassignedCards.length} cards without a directory code` : '')}
        </Text>
      </Flex>
      <Table.Root size="1" variant="surface">
        <SortHead cols={cols} sort={sort} onSort={(k) => setSort(nextSort(sort, k))} />
        <Table.Body>
          {rows.slice(0, MAX_ROWS).map((r) => (
            <Fragment key={r.directoryCode}>
              <Table.Row data-code={r.directoryCode}
                onClick={() => { setOpen(open === r.directoryCode ? null : r.directoryCode); setEditing(false); }}
                style={{ cursor: 'pointer', background: r.directoryCode === highlight ? 'var(--accent-a4)' : undefined,
                  color: r.hidden && kind === 'residents' ? 'var(--gray-10)' : undefined }}>
                {cols.map(([, k]) => (
                  <Table.Cell key={k} style={dupCell(r, k) ? { background: 'var(--red-a5)', color: 'var(--red-11)', fontWeight: 600 } : undefined}
                    title={dupCell(r, k) ? 'Also used by another entry' : undefined}>
                    {k === 'cards' ? <CardList cards={r.cards} devices={devices} dups={dups.card} />
                      : k === 'note' ? <Text as="div" className="note-cell" title={r.note || undefined}>{r.note}</Text>
                        : dirCell(r, k)}
                  </Table.Cell>
                ))}
              </Table.Row>
              {open === r.directoryCode && (
                <Table.Row>
                  <Table.Cell colSpan={cols.length} style={{ background: 'var(--gray-a2)' }}>
                    {editing && list ? (
                      <ResidentForm r={r} vendor={vendor} dirDigits={list.dirDigits} emptyCodes={list.emptyCodes} devices={devices}
                        features={features} gapi={gapi} onDone={async () => { setEditing(false); await onReload(); }} onCancel={() => setEditing(false)} />
                    ) : (
                      <Flex direction="column" gap="2">
                        <Flex gap="3" align="center" wrap="wrap">
                          {!readOnly && <Button size="1" variant="soft" onClick={() => setEditing(true)}>Edit</Button>}
                          <LastEdit r={r} gapi={gapi} version={list ? String(list.saved) : ''} />
                        </Flex>
                        <RecentTransactions r={r} tx={tx} snaps={snaps} onOpenSnap={onOpenSnap} />
                      </Flex>
                    )}
                  </Table.Cell>
                </Table.Row>
              )}
            </Fragment>
          ))}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}

// "Last edited by <user>, <time>" for a directory code, from History; clicking it lists every recorded change (what,
// when, who). Nothing is shown when History has none. version: reloads after the working copy changes.
function LastEdit({ r, gapi, version }: { r: ResidentRow; gapi: GateApi; version: string }) {
  const [changes, setChanges] = useState<EntryChange[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    gapi<{ changes: EntryChange[] }>('GET', `/residents/${encodeURIComponent(r.directoryCode)}/history`)
      .then((x) => { if (live) { setChanges(x.changes); setError(''); } }, (e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [gapi, r.directoryCode, version]);
  if (error) return <Text size="1" color="red">Change history unavailable: {error}</Text>;
  if (!changes || !changes.length) return null;
  const last = changes[0];
  return (
    <>
      <Link href="#" size="2" title="See every recorded change to this entry"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(true); }}>
        Last edited by {last.user} · {fmtTime(last.time)}{changes.length > 1 ? ` (${changes.length} changes)` : ''}
      </Link>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Content maxWidth="760px" aria-describedby={undefined} onClick={(e) => e.stopPropagation()}>
          <Flex align="center" mb="3">
            <Dialog.Title mb="0">Changes to directory code {r.directoryCode}{r.name ? ` (${r.name})` : ''}</Dialog.Title>
            <Flex flexGrow="1" />
            <Dialog.Close><IconButton variant="ghost" color="gray" title="Close">✕</IconButton></Dialog.Close>
          </Flex>
          <Flex direction="column" gap="3">
            {changes.map((c) => (
              <Card key={c.id}>
                <Flex direction="column" gap="1">
                  <Flex gap="2" align="center" wrap="wrap">
                    <Text size="2" weight="medium">{fmtTime(c.time)}</Text>
                    <Text size="2">by {c.user}</Text>
                    <Badge color="gray">{ACTIONS[c.action] || c.action}</Badge>
                    {c.change !== 'changed' && <Badge color={c.change === 'added' ? 'green' : 'red'}>{c.change}</Badge>}
                    {c.revertedBy && <Badge color="amber" title={`${c.revertedBy.user}, ${fmtTime(c.revertedBy.time)}`}>Reverted</Badge>}
                  </Flex>
                  <Text size="1" color="gray">{c.summary}</Text>
                  {c.fields.length > 0 && (
                    <Table.Root size="1">
                      <Table.Header><Table.Row>{['What', 'Before', 'After'].map((h) => <Table.ColumnHeaderCell key={h}>{h}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header>
                      <Table.Body>
                        {c.fields.map((f, i) => (
                          <Table.Row key={i}>
                            <Table.Cell>{f.field}</Table.Cell>
                            <Table.Cell><Text color="gray">{f.from || '—'}</Text></Table.Cell>
                            <Table.Cell>{f.to || '—'}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  )}
                </Flex>
              </Card>
            ))}
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

// Last 5 transactions for a resident (transaction rows are newest first), matched on directory code.
function RecentTransactions({ r, tx, snaps, onOpenSnap }: {
  r: ResidentRow; tx: TransactionRow[] | null; snaps: Snaps; onOpenSnap: (t: TransactionRow) => void;
}) {
  if (!tx) return <Text size="2" color="gray">No transactions yet. Pull transactions from the gate.</Text>;
  const recent = tx.filter((t) => t.directoryCode === r.directoryCode).slice(0, 5);
  if (!recent.length) return <Text size="2" color="gray">No transactions for this entry.</Text>;
  const cols: Column[] = snaps.settings ? [...HISTORY_COLUMNS, ['Camera', 'snap']] : HISTORY_COLUMNS;
  return (
    <Table.Root size="1">
      <Table.Header>
        <Table.Row>{cols.map(([label, k]) => <Table.ColumnHeaderCell key={k}>{label}</Table.ColumnHeaderCell>)}</Table.Row>
      </Table.Header>
      <Table.Body>
        {recent.map((t, i) => (
          <Table.Row key={i} style={txTone(t) ? { background: `var(--${txTone(t)}-a3)` } : undefined}>
            {cols.map(([, k]) => (
              <Table.Cell key={k}>
                {k === 'snap' ? <SnapCell t={t} snaps={snaps} onOpen={onOpenSnap} /> : String((t as unknown as Record<string, unknown>)[k] ?? '')}
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}
