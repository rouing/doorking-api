import { Fragment, useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Callout, Card, Dialog, Flex, Heading, IconButton, Link, Table, Text, TextField } from '@radix-ui/themes';
import type { DeviceRange, EntryChange, GateFeatures, ResidentRow, ResidentsReply, TransactionRow } from '../../../src/types.ts';
import { dirCell, doorKingCsv, downloadText, fieldOf, fmtTime, isEmptySlot, txTone } from '../format.ts';
import { nextSort, SortHead, sortRows, useShownRows, type Column, type Sort } from '../table.tsx';
import { CardList } from './fields.tsx';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';
import { ResidentForm } from './ResidentForm.tsx';
import { TX_COLUMNS } from './Transactions.tsx';
import { ACTIONS } from './History.tsx';
import { WorkingCopyBar } from './WorkingCopyBar.tsx';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { usePhone } from '../phone.ts';
import { useConfirm } from '../Confirm.tsx';

const COLUMNS: Record<'residents' | 'vendors', Column[]> = {
  residents: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Hidden', 'hidden'], ['Phone', 'phoneFull'],
    ['Entry Code', 'entryCode'], ['Security', 'securityLevel'], ['Floor', 'floor'], ['Elevator', 'elevatorRef'], ['Cards', 'cards'],
    ['Notes', 'note']],
  vendors: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Entry Code', 'entryCode'], ['Security', 'securityLevel'],
    ['Cards', 'cards'], ['Notes', 'note']],
};
const HISTORY_COLUMNS = TX_COLUMNS.filter(([, k]) => k !== 'name' && k !== 'directoryCode');

interface DirectoryProps {
  kind: 'residents' | 'vendors';
  account: string; // the site name, the export's ACCOUNT column
  list: ResidentsReply | null;
  tx: TransactionRow[] | null;
  devices: DeviceRange[];
  features: GateFeatures;
  snaps: Snaps;
  onOpenSnap: (transaction: TransactionRow) => void;
  highlight: string | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
}

// Residents or vendors in the working copy. Clicking a row shows its last 5 transactions and an Edit button;
// Add opens a form for a new entry.
export function Directory({ kind, account, list, tx, devices, features, snaps, onOpenSnap, highlight, gapi, onReload }: DirectoryProps) {
  const cols = COLUMNS[kind].filter(([, k]) => (k !== 'floor' || features.floors) && (k !== 'elevatorRef' || features.elevators));
  const vendor = kind === 'vendors';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const [open, setOpen] = useState<string | null>(highlight);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dialog, confirm] = useConfirm();
  // Back closes an open add or edit form, after asking (its typing would be lost).
  const leaveForm = () => confirm({ title: 'Leave this form?', body: 'Changes you haven\'t saved are lost.', action: 'Leave', color: 'red' });
  useBackLayer(adding, () => setAdding(false), leaveForm);
  useBackLayer(editing, () => setEditing(false), leaveForm);
  const readOnly = useReadOnly();
  const phone = usePhone(); // phones: no Export CSV

  useEffect(() => {
    setOpen(highlight);
    setEditing(false);
    if (!highlight) return;
    setFilter('');
    requestAnimationFrame(() => document.querySelector(`[data-code="${highlight}"]`)?.scrollIntoView({ block: 'center' }));
  }, [highlight]);

  const rows = useMemo(() => {
    let out = (list ? list.rows : []).filter((resident) => (resident.type === 'Vendor') === (kind === 'vendors') && !isEmptySlot(resident));
    const query = filter.trim().toLowerCase();
    if (query) out = out.filter((resident) => [...Object.values(resident), dirCell(resident, 'securityLevel')].join(' ').toLowerCase().includes(query));
    return sortRows(out, sort, (col) => (resident: ResidentRow) => dirCell(resident, col));
  }, [list, kind, filter, sort]);
  // Values held by more than one entry (all kinds, so a clash between a resident and a vendor shows on both pages).
  const dups = useMemo(() => {
    const of = (kindOf: string) => new Set((list?.duplicates || []).filter((duplicate) => duplicate.kind === kindOf).map((duplicate) => duplicate.value));
    return { directoryCode: of('directoryCode'), entryCode: of('entryCode'), card: of('card') };
  }, [list]);
  const dupCell = (resident: ResidentRow, column: string) => (column === 'directoryCode' && dups.directoryCode.has(resident.directoryCode))
    || (column === 'entryCode' && Boolean(resident.entryCode) && dups.entryCode.has(resident.entryCode));

  const { limit, more } = useShownRows(rows.length, `${filter}|${kind}`);
  const end = Math.max(limit, rows.findIndex((resident) => resident.directoryCode === highlight) + 1); // a highlighted entry always shows

  // Every directory code (residents, vendors and empty slots), in DoorKing's cloud export format.
  const csv = () => list && downloadText('ResidentsExport.csv', doorKingCsv(account, list.rows || [], list.unassignedCards));

  return (
    <Flex direction="column" gap="3">
      {dialog}
      <Heading>{kind === 'vendors' ? 'Vendors' : 'Residents'}</Heading>
      <WorkingCopyBar cache={list ? list.cache : null} gapi={gapi} onReload={onReload} />
      {list && list.duplicates.length > 0 && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            <strong>Duplicate {list.duplicates.length === 1 ? 'number' : 'numbers'}: two or more entries share a directory code, entry code or card.</strong>{' '}
            The gate can't tell them apart, so <strong>Send to gate is refused</strong> until each is changed or removed (marked red below).
          </Callout.Text>
          <Box asChild><ul style={{ margin: 0 }}>{list.duplicates.map((duplicate) => <li key={`${duplicate.kind}-${duplicate.value}`}>{duplicate.text}</li>)}</ul></Box>
        </Callout.Root>
      )}
      {adding && list && (
        <Card>
          <ResidentForm resident={null} vendor={vendor} dirDigits={list.dirDigits} emptyCodes={list.emptyCodes} devices={devices}
            features={features} gapi={gapi} onDone={async () => { setAdding(false); await onReload(); }} onCancel={() => setAdding(false)} />
        </Card>
      )}
      <Flex gap="3" align="center" wrap="wrap">
        {!readOnly && <Button onClick={() => setAdding(!adding)} disabled={!list}>{vendor ? 'Add vendor' : 'Add resident'}</Button>}
        <TextField.Root type="search" placeholder="Filter rows" value={filter} onChange={(event) => setFilter(event.target.value)} />
        {!phone && <Button variant="soft" onClick={csv} disabled={!list} title="Every directory code (residents, vendors and empty units), in the format DoorKing's cloud exports">Export CSV</Button>}
        <Text size="2" color="gray">
          {!list ? 'No data yet. Pull residents from the gate.'
            : `${rows.length} ${kind}${rows.length > limit ? ` (first ${limit} shown)` : ''} · downloaded ${fmtTime(list.updated)}`
              + (kind === 'residents' && list.unassignedCards.length ? ` · ${list.unassignedCards.length} cards without a directory code` : '')}
        </Text>
      </Flex>
      <Table.Root size="1" variant="surface" className="dir-table">
        <SortHead cols={cols} sort={sort} onSort={(column) => setSort(nextSort(sort, column))} />
        <Table.Body>
          {rows.slice(0, end).map((resident) => (
            <Fragment key={resident.directoryCode}>
              <Table.Row className="card-row" data-code={resident.directoryCode} data-open={open === resident.directoryCode || undefined}
                onClick={() => { setOpen(open === resident.directoryCode ? null : resident.directoryCode); setEditing(false); }}
                style={{ cursor: 'pointer', background: resident.directoryCode === highlight ? 'var(--accent-a4)' : undefined,
                  color: resident.hidden && kind === 'residents' ? 'var(--gray-10)' : undefined }}>
                {cols.map(([, k]) => (
                  <Table.Cell key={k} data-col={k} style={dupCell(resident, k) ? { background: 'var(--red-a5)', color: 'var(--red-11)', fontWeight: 600 } : undefined}
                    title={dupCell(resident, k) ? 'Also used by another entry' : undefined}>
                    {k === 'cards' ? <CardList cards={resident.cards} devices={devices} dups={dups.card} />
                      : k === 'note' ? <Text as="div" className="note-cell" title={resident.note || undefined}>{resident.note}</Text>
                        : dirCell(resident, k)}
                  </Table.Cell>
                ))}
              </Table.Row>
              {open === resident.directoryCode && (
                <Table.Row className="detail-row">
                  <Table.Cell colSpan={cols.length} style={{ background: 'var(--gray-a2)' }}>
                    {editing && list ? (
                      <ResidentForm resident={resident} vendor={vendor} dirDigits={list.dirDigits} emptyCodes={list.emptyCodes} devices={devices}
                        features={features} gapi={gapi} onDone={async () => { setEditing(false); await onReload(); }} onCancel={() => setEditing(false)} />
                    ) : (
                      <Flex direction="column" gap="2">
                        <Flex gap="3" align="center" wrap="wrap">
                          {!readOnly && <Button size="1" variant="soft" onClick={() => setEditing(true)}>Edit</Button>}
                          <LastEdit resident={resident} gapi={gapi} version={list ? String(list.saved) : ''} />
                        </Flex>
                        <RecentTransactions resident={resident} tx={tx} snaps={snaps} onOpenSnap={onOpenSnap} />
                      </Flex>
                    )}
                  </Table.Cell>
                </Table.Row>
              )}
            </Fragment>
          ))}
        </Table.Body>
      </Table.Root>
      {more}
    </Flex>
  );
}

interface LastEditProps {
  resident: ResidentRow;
  gapi: GateApi;
  version: string;
}

// "Last edited by <user>, <time>" for a directory code, from History; clicking it lists every recorded change (what,
// when, who). Nothing is shown when History has none. version: reloads after the working copy changes.
function LastEdit({ resident, gapi, version }: LastEditProps) {
  const [changes, setChanges] = useState<EntryChange[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  useEffect(() => {
    let live = true;
    gapi<{ changes: EntryChange[] }>('GET', `/residents/${encodeURIComponent(resident.directoryCode)}/history`)
      .then((reply) => { if (live) { setChanges(reply.changes); setError(''); } }, (err) => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, [gapi, resident.directoryCode, version]);
  if (error) return <Text size="1" color="red">Change history unavailable: {error}</Text>;
  if (!changes || !changes.length) return null;
  const last = changes[0];
  return (
    <>
      <Link href="#" size="2" title="See every recorded change to this entry"
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}>
        Last edited by {last.user} · {fmtTime(last.time)}{changes.length > 1 ? ` (${changes.length} changes)` : ''}
      </Link>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Content maxWidth="760px" aria-describedby={undefined} onClick={(event) => event.stopPropagation()}>
          <Flex align="center" mb="3">
            <Dialog.Title mb="0">Changes to directory code {resident.directoryCode}{resident.name ? ` (${resident.name})` : ''}</Dialog.Title>
            <Flex flexGrow="1" />
            <Dialog.Close><IconButton variant="ghost" color="gray" title="Close">✕</IconButton></Dialog.Close>
          </Flex>
          <Flex direction="column" gap="3">
            {changes.map((change) => (
              <Card key={change.id}>
                <Flex direction="column" gap="1">
                  <Flex gap="2" align="center" wrap="wrap">
                    <Text size="2" weight="medium">{fmtTime(change.time)}</Text>
                    <Text size="2">by {change.user}</Text>
                    <Badge color="gray">{ACTIONS[change.action] || change.action}</Badge>
                    {change.change !== 'changed' && <Badge color={change.change === 'added' ? 'green' : 'red'}>{change.change}</Badge>}
                    {change.revertedBy && <Badge color="amber" title={`${change.revertedBy.user}, ${fmtTime(change.revertedBy.time)}`}>Reverted</Badge>}
                  </Flex>
                  <Text size="1" color="gray">{change.summary}</Text>
                  {change.fields.length > 0 && (
                    <Table.Root size="1">
                      <Table.Header><Table.Row>{['What', 'Before', 'After'].map((header) => <Table.ColumnHeaderCell key={header}>{header}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header>
                      <Table.Body>
                        {change.fields.map((field, i) => (
                          <Table.Row key={i}>
                            <Table.Cell>{field.field}</Table.Cell>
                            <Table.Cell><Text color="gray">{field.from || '—'}</Text></Table.Cell>
                            <Table.Cell>{field.to || '—'}</Table.Cell>
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

interface RecentTransactionsProps {
  resident: ResidentRow;
  tx: TransactionRow[] | null;
  snaps: Snaps;
  onOpenSnap: (transaction: TransactionRow) => void;
}

// Last 5 transactions for a resident (transaction rows are newest first), matched on directory code.
function RecentTransactions({ resident, tx, snaps, onOpenSnap }: RecentTransactionsProps) {
  if (!tx) return <Text size="2" color="gray">No transactions yet. Pull transactions from the gate.</Text>;
  const recent = tx.filter((transaction) => transaction.directoryCode === resident.directoryCode).slice(0, 5);
  if (!recent.length) return <Text size="2" color="gray">No transactions for this entry.</Text>;
  const cols: Column[] = snaps.settings ? [...HISTORY_COLUMNS, ['Camera', 'snap']] : HISTORY_COLUMNS;
  return (
    <Table.Root size="1">
      <Table.Header>
        <Table.Row>{cols.map(([label, k]) => <Table.ColumnHeaderCell key={k}>{label}</Table.ColumnHeaderCell>)}</Table.Row>
      </Table.Header>
      <Table.Body>
        {recent.map((transaction, i) => (
          <Table.Row key={i} style={txTone(transaction) ? { background: `var(--${txTone(transaction)}-a3)` } : undefined}>
            {cols.map(([, k]) => (
              <Table.Cell key={k}>
                {k === 'snap' ? <SnapCell transaction={transaction} snaps={snaps} onOpen={onOpenSnap} /> : String(fieldOf(transaction, k) ?? '')}
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}
