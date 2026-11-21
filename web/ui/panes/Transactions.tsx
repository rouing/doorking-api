import { useMemo, useState } from 'react';
import { errorText } from '../api.ts';
import { Button, Flex, Heading, Link, Progress, Table, Text, TextField } from '@radix-ui/themes';
import { Choice } from './fields.tsx';
import type { ResidentRow, TransactionRow } from '../../../src/types.ts';
import { cell, downloadCsv, fmtTime, residentFinder, txTone } from '../format.ts';
import { MAX_ROWS, nextSort, SortHead, sortRows, type Column, type Sort } from '../table.tsx';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';

export const TX_COLUMNS: Column[] = [['Date', 'date'], ['Time', 'time'], ['Event Type', 'eventType'], ['Number', 'number'],
  ['Name', 'name'], ['Access', 'access'], ['Relay', 'relay'], ['APB', 'apb'], ['Directory Code', 'directoryCode']];

const txValue = (col: string) => (col === 'time'
  ? (transaction: TransactionRow) => { const date = new Date(transaction.ts); return date.getHours() * 60 + date.getMinutes(); }
  : (transaction: TransactionRow) => (transaction as unknown as Record<string, unknown>)[col]);

// The gate's transaction log (rcv_out.bin), newest first. Names and numbers link to the resident/vendor; with
// camera settings saved, a Camera column shows each transaction's pictures (or videos). The newest transactions are
// loaded first; Load older transactions adds the page before them (onLoadOlder).
export function Transactions({ tx, onLoadOlder, residents, onOpenResident, snaps, onOpenSnap }: {
  tx: { updated: string; rows: TransactionRow[]; next?: number | null } | null;
  onLoadOlder: () => Promise<void>;
  residents: ResidentRow[];
  onOpenResident: (resident: ResidentRow) => void;
  snaps: Snaps;
  onOpenSnap: (transaction: TransactionRow) => void;
}) {
  const cols: Column[] = snaps.settings ? [...TX_COLUMNS, ['Camera', 'snap']] : TX_COLUMNS;
  const p = snaps.run && snaps.running ? snaps.run.progress : undefined;
  const [days, setDays] = useState('7');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const [older, setOlder] = useState('');
  const loadOlder = async () => {
    setOlder('Loading…');
    try { await onLoadOlder(); setOlder(''); } catch (err) { setOlder(`Not loaded: ${errorText(err)}`); }
  };
  const who = useMemo(() => residentFinder(residents), [residents]);

  const rows = useMemo(() => {
    let out = tx ? tx.rows : [];
    const n = Number(days);
    if (n && out.length) {
      const since = out[0].ts - n * 86400000;
      out = out.filter((transaction) => transaction.ts >= since);
    }
    const q = filter.trim().toLowerCase();
    if (q) out = out.filter((transaction) => Object.values(transaction).join(' ').toLowerCase().includes(q));
    return sortRows(out, sort, txValue);
  }, [tx, days, filter, sort]);

  const link = (text: string, resident: ResidentRow) => (
    <Link href="#" title={`Open ${resident.name || `directory code ${resident.directoryCode}`} (code ${resident.directoryCode})`}
      onClick={(event) => { event.preventDefault(); onOpenResident(resident); }}>{text}</Link>
  );

  const csv = () => downloadCsv('transactions.csv', TX_COLUMNS.map((column) => column[0]),
    rows.map((transaction) => TX_COLUMNS.map(([, k]) => cell((transaction as unknown as Record<string, unknown>)[k]))));

  return (
    <Flex direction="column" gap="3">
      <Heading>Transactions</Heading>
      <Flex gap="3" align="center" wrap="wrap">
        <Choice value={days} onChange={setDays} options={[['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['0', 'All']]} />
        <TextField.Root type="search" placeholder="Filter rows" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <Button variant="soft" onClick={csv} disabled={!rows.length}>Download CSV</Button>
        {snaps.settings && (
          <Button variant="soft" disabled={snaps.running} onClick={snaps.runAll}>
            {snaps.video ? 'Get camera videos' : 'Get camera snapshots'}
          </Button>
        )}
        {snaps.settings && snaps.running && (
          <Button variant="soft" color="gray" disabled={Boolean(snaps.run?.stopping)} onClick={snaps.stop}>
            {snaps.video ? 'Stop videos' : 'Stop snapshots'}
          </Button>
        )}
        {snaps.settings && snaps.running && (
          <Progress value={p && p.frames ? (p.framesDone / p.frames) * 100 : undefined} style={{ width: 120 }} />
        )}
        <Text size="2" color="gray">
          {!tx ? 'No transactions yet. Pull transactions from the gate.'
            : `${rows.length} transactions${rows.length > MAX_ROWS ? ` (first ${MAX_ROWS} shown)` : ''} · downloaded ${fmtTime(tx.updated)}`}
        </Text>
        {tx && tx.next != null && (
          <Button variant="soft" color="gray" onClick={loadOlder} disabled={older === 'Loading…'}
            title={`Only the newest ${tx.rows.length} transactions are loaded`}>Load older transactions</Button>
        )}
        {older && <Text size="2" color="gray">{older}</Text>}
      </Flex>
      {snaps.settings && snaps.info && <Text size="2" color="gray">{snaps.info}</Text>}
      <Table.Root size="1" variant="surface">
        <SortHead cols={cols} sort={sort} onSort={(k) => { if (k !== 'snap') setSort(nextSort(sort, k, true)); }}
          title={(k) => (k === 'time' ? 'Click to sort. After sorting by Date, sorts the times within each date.' : 'Click to sort')} />
        <Table.Body>
          {rows.slice(0, MAX_ROWS).map((transaction, i) => {
            const r = who(transaction);
            const tone = txTone(transaction);
            return (
              <Table.Row key={`${transaction.raw}-${i}`} style={tone ? { background: `var(--${tone}-a3)` } : undefined}>
                {cols.map(([, k]) => (
                  <Table.Cell key={k}>
                    {k === 'snap' ? <SnapCell t={transaction} snaps={snaps} onOpen={onOpenSnap} />
                      : r && k === 'name' && transaction.name && transaction.directoryCode ? link(transaction.name, r)
                      : r && k === 'number' && transaction.number ? link(transaction.number, r)
                        : cell((transaction as unknown as Record<string, unknown>)[k])}
                  </Table.Cell>
                ))}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}
