import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { errorText } from '../api.ts';
import { Button, Flex, Heading, Link, Progress, Table, Text, TextField } from '@radix-ui/themes';
import { Choice } from './fields.tsx';
import type { ResidentRow, TransactionRow } from '../../../src/types.ts';
import { cell, downloadCsv, fieldOf, fmtTime, residentFinder, txTone } from '../format.ts';
import { nextSort, SortHead, sortRows, useShownRows, type Column, type Sort } from '../table.tsx';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';

export const TX_COLUMNS: Column[] = [['Date', 'date'], ['Time', 'time'], ['Event Type', 'eventType'], ['Number', 'number'],
  ['Name', 'name'], ['Access', 'access'], ['Relay', 'relay'], ['APB', 'apb'], ['Directory Code', 'directoryCode']];

const txValue = (col: string) => (col === 'time'
  ? (transaction: TransactionRow) => { const date = new Date(transaction.ts); return date.getHours() * 60 + date.getMinutes(); }
  : (transaction: TransactionRow) => fieldOf(transaction, col));

interface TransactionsProps {
  tx: { updated: string; rows: TransactionRow[]; next?: number | null } | null;
  onLoadOlder: () => Promise<void>;
  residents: ResidentRow[];
  onOpenResident: (resident: ResidentRow) => void;
  snaps: Snaps;
  onOpenSnap: (transaction: TransactionRow) => void;
}

// The gate's transaction log (rcv_out.bin), newest first. Names and numbers link to the resident/vendor; with
// camera settings saved, a Camera column shows each transaction's pictures (or videos). The newest transactions are
// loaded first; Load older transactions adds the page before them (onLoadOlder).
export function Transactions({ tx, onLoadOlder, residents, onOpenResident, snaps, onOpenSnap }: TransactionsProps) {
  const cols: Column[] = snaps.settings ? [...TX_COLUMNS, ['Camera', 'snap']] : TX_COLUMNS;
  const progress = snaps.run && snaps.running ? snaps.run.progress : undefined;
  const [days, setDays] = useState('7');
  const [filter, setFilter] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null); // phones: the card showing every value
  const [sort, setSort] = useState<Sort | null>(null);
  const [older, setOlder] = useState('');

  const who = useMemo(() => residentFinder(residents), [residents]);

  const rows = useMemo(() => {
    let out = tx ? tx.rows : [];
    const count = Number(days);
    if (count && out.length) {
      const since = out[0].ts - count * 86400000;
      out = out.filter((transaction) => transaction.ts >= since);
    }
    const query = filter.trim().toLowerCase();
    if (query) out = out.filter((transaction) => Object.values(transaction).join(' ').toLowerCase().includes(query));
    return sortRows(out, sort, txValue);
  }, [tx, days, filter, sort]);

  const link = (text: string, resident: ResidentRow) => (
    <Link href="#" title={`Open ${resident.name || `directory code ${resident.directoryCode}`} (code ${resident.directoryCode})`}
      onClick={(event) => { event.preventDefault(); onOpenResident(resident); }}>{text}</Link>
  );

  const csv = () => downloadCsv('transactions.csv', TX_COLUMNS.map((column) => column[0]),
    rows.map((transaction) => TX_COLUMNS.map(([, k]) => cell(fieldOf(transaction, k)))));

  const { limit, more, showMore } = useShownRows(rows.length, `${filter}|${days}`);
  // The older page is added at the end, so the table grows by a step to show it (2,000 rows; 100 on a phone).
  const [olderLoaded, setOlderLoaded] = useState(0);
  useEffect(() => { if (olderLoaded) showMore(); }, [olderLoaded]);
  const loadOlder = async () => {
    setOlder('Loading…');
    try { await onLoadOlder(); setOlder(''); setOlderLoaded((n) => n + 1); } catch (err) { setOlder(`Not loaded: ${errorText(err)}`); }
  };
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
          <Progress value={progress && progress.frames ? (progress.framesDone / progress.frames) * 100 : undefined} style={{ width: 120 }} />
        )}
        <Text size="2" color="gray">
          {!tx ? 'No transactions yet. Pull transactions from the gate.'
            : `${rows.length} transactions${rows.length > limit ? ` (first ${limit} shown)` : ''} · downloaded ${fmtTime(tx.updated)}`}
        </Text>
        {tx && tx.next != null && (
          <Button variant="soft" color="gray" onClick={loadOlder} disabled={older === 'Loading…'}
            title={`Only the newest ${tx.rows.length} transactions are loaded`}>Load older transactions</Button>
        )}
        {older && <Text size="2" color="gray">{older}</Text>}
      </Flex>
      {snaps.settings && snaps.info && <Text size="2" color="gray">{snaps.info}</Text>}
      <Table.Root size="1" variant="surface" className="tx-table">
        <SortHead cols={cols} sort={sort} onSort={(column) => { if (column !== 'snap') setSort(nextSort(sort, column, true)); }}
          title={(column) => (column === 'time' ? 'Click to sort. After sorting by Date, sorts the times within each date.' : 'Click to sort')} />
        <Table.Body>
          {rows.slice(0, limit).map((transaction, i) => {
            const person = who(transaction);
            const tone = txTone(transaction);
            const id = `${transaction.raw}-${i}`;
            // Phones show each transaction as a card with its main values; tapping it (not a link or button) shows the rest.
            const toggle = (event: MouseEvent) => {
              if (!(event.target as Element).closest('a, button')) setOpenRow(openRow === id ? null : id);
            };
            return (
              <Table.Row key={id} className="card-row" data-open={openRow === id || undefined} onClick={toggle}
                style={tone ? { background: `var(--${tone}-a3)` } : undefined}>
                {cols.map(([, k]) => (
                  <Table.Cell key={k} data-col={k}>
                    {k === 'snap' ? <SnapCell transaction={transaction} snaps={snaps} onOpen={onOpenSnap} />
                      : person && k === 'name' && transaction.name && transaction.directoryCode ? link(transaction.name, person)
                      : person && k === 'number' && transaction.number ? link(transaction.number, person)
                        : cell(fieldOf(transaction, k))}
                  </Table.Cell>
                ))}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      {more}
    </Flex>
  );
}
