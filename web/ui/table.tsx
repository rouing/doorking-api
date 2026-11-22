import { useEffect, useState, type ReactNode } from 'react';
import { Button, Flex, Table, Text } from '@radix-ui/themes';
import { usePhone } from './phone.ts';
import { cmpCells } from './format.ts';

export type Column = [label: string, key: string];
export interface Sort { col: string; dir: 1 | -1; then?: { col: string; dir: 1 | -1 } }

// Next sort for a header click. With dateTime (Transactions): Time clicked while sorted by Date sorts the times
// within each date (Date stays first); clicking Date again flips the dates and keeps that.
export function nextSort(cur: Sort | null, key: string, dateTime = false): Sort {
  if (dateTime && cur && cur.col === 'date') {
    if (key === 'time') return { col: 'date', dir: cur.dir, then: { col: 'time', dir: cur.then ? (-cur.then.dir as 1 | -1) : 1 } };
    if (key === 'date' && cur.then) return { ...cur, dir: -cur.dir as 1 | -1 };
  }
  return { col: key, dir: cur && cur.col === key && !cur.then ? (-cur.dir as 1 | -1) : 1 };
}

// Rows sorted by `sort`; value(col) gives the value a column sorts on.
export function sortRows<R>(rows: R[], sort: Sort | null, value: (col: string) => (row: R) => unknown): R[] {
  if (!sort) return rows;
  const first = value(sort.col);
  const then = sort.then;
  const second = then && value(then.col);
  return [...rows].sort((a, b) => cmpCells(first(a), first(b)) * sort.dir || (second && then ? cmpCells(second(a), second(b)) * then.dir : 0));
}

interface SortHeadProps {
  cols: Column[];
  sort: Sort | null;
  onSort: (key: string) => void;
  title?: (key: string) => string;
}

// Header row whose cells sort the table on click (▲/▼, with 1/2 for a two-level sort).
export function SortHead({ cols, sort, onSort, title }: SortHeadProps) {
  const arrow = (dir: number) => (dir > 0 ? ' ▲' : ' ▼');
  return (
    <Table.Header className="sort-head">
      <Table.Row>
        {cols.map(([label, key]) => (
          <Table.ColumnHeaderCell key={key} onClick={() => onSort(key)} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
            title={title ? title(key) : 'Click to sort'}>
            {label}
            {!sort ? '' : sort.col === key ? arrow(sort.dir) + (sort.then ? ' 1' : '')
              : sort.then && sort.then.col === key ? `${arrow(sort.then.dir)} 2` : ''}
          </Table.ColumnHeaderCell>
        ))}
      </Table.Row>
    </Table.Header>
  );
}

const PAGE_ROWS = 2000; // rows drawn at a time (and per Show more)
const PHONE_ROWS = 100; // the same on phones

interface ShownRows {
  limit: number; // rows to draw
  more: ReactNode; // the Show more row, or null when everything shows
  showMore: () => void; // draws one step more (after loading more rows), as Show more does
}

// How many rows a long table draws: PAGE_ROWS (phones: PHONE_ROWS), and that many more each time Show more is
// clicked, so every row can be reached (rows added later, such as older transactions, too). Back to one page when
// `reset` changes, such as the filter.
export function useShownRows(total: number, reset: unknown): ShownRows {
  const step = usePhone() ? PHONE_ROWS : PAGE_ROWS;
  const [pages, setPages] = useState(1);
  useEffect(() => { setPages(1); }, [reset]);
  const limit = step * pages;
  const more = total > limit ? (
    <Flex align="center" gap="3" wrap="wrap">
      <Text size="2" color="gray">Showing {limit} of {total}</Text>
      <Button variant="soft" onClick={() => setPages(pages + 1)}>Show {Math.min(step, total - limit)} more</Button>
    </Flex>
  ) : null;
  return { limit, more, showMore: () => setPages((shown) => shown + 1) };
}
