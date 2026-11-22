import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { errorText } from '../api.ts';
import { Button, Flex, Heading, Link, Progress, Table, Text, TextField } from '@radix-ui/themes';
import { Choice } from './fields.tsx';
import type { ResidentRow, TransactionRow } from '../../../src/types.ts';
import { cell, downloadCsv, fieldOf, fmtTime, residentFinder, txTone } from '../format.ts';
import { nextSort, SortHead, sortRows, useShownRows, type Column, type Sort } from '../table.tsx';
import { usePhone } from '../phone.ts';
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

/**
 * Window-level table virtualization for desktop transaction rows (`@tanstack/react-virtual`).
 * Measures the table container's document-relative offset (`getBoundingClientRect().top + scrollY`)
 * and re-measures when resize or banner layout dependencies change.
 *
 * @param count - Number of virtualized rows (`0` on phones).
 * @param estimateSize - Estimated row height in pixels.
 * @param measureDeps - Values that may shift the table's vertical offset when toggled.
 * @returns Container ref, virtualizer handle, visible items, and top/bottom spacer heights.
 */
function useTableVirtualizer(count: number, estimateSize: number, measureDeps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (!count) return;
    const measure = () => {
      const element = containerRef.current;
      if (element) setScrollMargin(element.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [count > 0, ...measureDeps]);
  const virtualizer = useWindowVirtualizer({ count, estimateSize: () => estimateSize, overscan: 15, scrollMargin });
  const items = count ? virtualizer.getVirtualItems() : [];
  const topPad = items.length > 0 ? Math.max(0, items[0].start - scrollMargin) : 0;
  const bottomPad = items.length > 0 ? Math.max(0, virtualizer.getTotalSize() - (items[items.length - 1].end - scrollMargin)) : 0;
  return { containerRef, virtualizer, items, topPad, bottomPad };
}

interface TransactionRowViewProps {
  transaction: TransactionRow;
  index: number;
  cols: Column[];
  person: ResidentRow | null;
  snaps: Snaps;
  isOpen: boolean;
  onToggle: () => void;
  onOpenResident: (resident: ResidentRow) => void;
  onOpenSnap: (transaction: TransactionRow) => void;
  rowRef?: (element: HTMLTableRowElement | null) => void;
}

/**
 * Renders one transaction row (desktop table row or expandable phone card).
 *
 * @param props - Row render props.
 * @param props.transaction - Transaction row to display.
 * @param props.index - Row index in the filtered/sorted list.
 * @param props.cols - Visible table columns.
 * @param props.person - Matching resident/vendor, or `null`.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.isOpen - Whether the phone card is expanded.
 * @param props.onToggle - Toggles phone card expansion.
 * @param props.onOpenResident - Callback to jump to the matching resident entry.
 * @param props.onOpenSnap - Callback to open the snapshot viewer for this transaction.
 * @param [props.rowRef] - Optional virtualizer measurement ref callback.
 * @returns Rendered table row element.
 */
function TransactionRowView({
  transaction, index, cols, person, snaps, isOpen, onToggle, onOpenResident, onOpenSnap, rowRef,
}: TransactionRowViewProps) {
  const tone = txTone(transaction);
  const handleClick = (event: MouseEvent) => {
    if (!(event.target as Element).closest('a, button')) onToggle();
  };
  const residentLink = (label: string, resident: ResidentRow) => (
    <Link href="#" title={`Open ${resident.name || `directory code ${resident.directoryCode}`} (code ${resident.directoryCode})`}
      onClick={(event) => { event.preventDefault(); onOpenResident(resident); }}>{label}</Link>
  );
  return (
    <Table.Row ref={rowRef} data-index={index} className="card-row" data-open={isOpen || undefined} onClick={handleClick}
      style={tone ? { background: `var(--${tone}-a3)` } : undefined}>
      {cols.map(([, key]) => (
        <Table.Cell key={key} data-col={key}>
          {key === 'snap' ? <SnapCell transaction={transaction} snaps={snaps} onOpen={onOpenSnap} />
            : person && key === 'name' && transaction.name && transaction.directoryCode ? residentLink(transaction.name, person)
            : person && key === 'number' && transaction.number ? residentLink(transaction.number, person)
              : cell(fieldOf(transaction, key))}
        </Table.Cell>
      ))}
    </Table.Row>
  );
}

/**
 * The gate's transaction log (`rcv_out.bin`), newest first. Names and numbers link to the resident/vendor; with
 * camera settings saved, a Camera column shows each transaction's pictures (or videos). The newest transactions are
 * loaded first; Load older transactions adds the page before them (`onLoadOlder`). On desktop the table is virtualized
 * (`@tanstack/react-virtual`) so thousands of loaded rows scroll smoothly with a small DOM; phones page cards 100 at a time.
 *
 * @param props - Component props.
 * @param props.tx - Loaded gate transactions (`{ updated, rows, next }`), or `null` before a pull.
 * @param props.onLoadOlder - Callback to fetch the next older page of transactions.
 * @param props.residents - Resident/vendor rows used to link names and numbers.
 * @param props.onOpenResident - Callback to jump to a resident entry.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpenSnap - Callback to open the snapshot viewer for a transaction.
 * @returns Rendered React element.
 */
export function Transactions({ tx, onLoadOlder, residents, onOpenResident, snaps, onOpenSnap }: TransactionsProps) {
  const cols: Column[] = snaps.settings ? [...TX_COLUMNS, ['Camera', 'snap']] : TX_COLUMNS;
  const progress = snaps.run && snaps.running ? snaps.run.progress : undefined;
  const phone = usePhone();
  const [days, setDays] = useState('7');
  const [filter, setFilter] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort | null>(null);
  const [older, setOlder] = useState('');
  const [olderLoaded, setOlderLoaded] = useState(0);

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

  const { limit, more, showMore } = useShownRows(phone ? rows.length : 0, `${filter}|${days}`);
  useEffect(() => { if (olderLoaded && phone) showMore(); }, [olderLoaded, phone]);
  const loadOlder = async () => {
    setOlder('Loading…');
    try { await onLoadOlder(); setOlder(''); setOlderLoaded((count) => count + 1); } catch (err) { setOlder(`Not loaded: ${errorText(err)}`); }
  };
  const csv = () => downloadCsv('transactions.csv', TX_COLUMNS.map((column) => column[0]),
    rows.map((transaction) => TX_COLUMNS.map(([, key]) => cell(fieldOf(transaction, key)))));

  const { containerRef, virtualizer, items, topPad, bottomPad } = useTableVirtualizer(
    phone ? 0 : rows.length,
    snaps.settings ? 58 : 36,
    [Boolean(snaps.settings), Boolean(snaps.info), Boolean(snaps.running), Boolean(progress), Boolean(older)],
  );

  const renderEntry = (transaction: TransactionRow, index: number, rowRef?: (element: HTMLTableRowElement | null) => void) => {
    const id = `${transaction.raw}-${index}`;
    return (
      <TransactionRowView key={id} transaction={transaction} index={index} cols={cols} person={who(transaction)} snaps={snaps}
        isOpen={openRow === id} onToggle={() => setOpenRow(openRow === id ? null : id)}
        onOpenResident={onOpenResident} onOpenSnap={onOpenSnap} rowRef={rowRef} />
    );
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
            : `${rows.length} transactions${phone && rows.length > limit ? ` (first ${limit} shown)` : ''} · downloaded ${fmtTime(tx.updated)}`}
        </Text>
        {tx && tx.next != null && (
          <Button variant="soft" color="gray" onClick={loadOlder} disabled={older === 'Loading…'}
            title={`Only the newest ${tx.rows.length} transactions are loaded`}>Load older transactions</Button>
        )}
        {older && <Text size="2" color="gray">{older}</Text>}
      </Flex>
      {snaps.settings && snaps.info && <Text size="2" color="gray">{snaps.info}</Text>}
      <div ref={containerRef}>
        <Table.Root size="1" variant="surface" className="tx-table">
          <SortHead cols={cols} sort={sort} onSort={(column) => { if (column !== 'snap') setSort(nextSort(sort, column, true)); }}
            title={(column) => (column === 'time' ? 'Click to sort. After sorting by Date, sorts the times within each date.' : 'Click to sort')} />
          <Table.Body>
            {phone ? rows.slice(0, limit).map((transaction, index) => renderEntry(transaction, index)) : (
              <>
                {topPad > 0 && <tr aria-hidden="true" style={{ height: topPad }}><td colSpan={cols.length} style={{ padding: 0, border: 0, height: topPad }} /></tr>}
                {items.map((item) => renderEntry(rows[item.index], item.index, virtualizer.measureElement))}
                {bottomPad > 0 && <tr aria-hidden="true" style={{ height: bottomPad }}><td colSpan={cols.length} style={{ padding: 0, border: 0, height: bottomPad }} /></tr>}
              </>
            )}
          </Table.Body>
        </Table.Root>
      </div>
      {phone && more}
    </Flex>
  );
}
