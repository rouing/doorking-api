/**
 * @module web/ui/nav/QuickJump
 *
 * Global Cmd/Ctrl+K quick-jump search dialog for the open gate: instant search across residents, vendors, cards,
 * entry codes, phone numbers, notes, recent transactions, and pages.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Badge, Box, Dialog, Flex, Text, TextField } from '@radix-ui/themes';
import type { ResidentRow, TransactionRow } from '../../../src/types.ts';
import { useBackLayer } from '../back.ts';
import type { NavKey } from './pages.ts';
import { searchGate, type QuickJumpHit } from './quickJumpSearch.ts';

interface QuickJumpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  residents: ResidentRow[];
  transactions: TransactionRow[];
  elevators: boolean;
  onGoPage: (page: NavKey) => void;
  onOpenResident: (resident: ResidentRow) => void;
  onOpenTransaction: (transaction: TransactionRow) => void;
}

const KIND_BADGE: Record<QuickJumpHit['kind'], { label: string; color: 'blue' | 'amber' | 'gray' }> = {
  resident: { label: 'Directory', color: 'blue' },
  transaction: { label: 'Activity', color: 'amber' },
  page: { label: 'Page', color: 'gray' },
};

/**
 * Global Quick-Jump dialog (`Cmd/Ctrl+K`) for jumping directly to any resident, card, entry code, transaction, or page.
 *
 * @param props - Component props.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Callback toggling open state.
 * @param props.residents - Loaded working-copy resident/vendor rows.
 * @param props.transactions - Loaded transaction rows.
 * @param props.elevators - Whether elevator pages are shown.
 * @param props.onGoPage - Navigates to a gate page.
 * @param props.onOpenResident - Jumps to and highlights a resident/vendor.
 * @param props.onOpenTransaction - Opens a transaction (or its snapshot viewer).
 * @returns Rendered React element.
 */
export function QuickJump({
  open, onOpenChange, residents, transactions, elevators, onGoPage, onOpenResident, onOpenTransaction,
}: QuickJumpProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  useBackLayer(open, () => onOpenChange(false));

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); }
  }, [open]);

  const hits = useMemo(
    () => searchGate(query, { residents, transactions, elevators }),
    [query, residents, transactions, elevators],
  );

  useEffect(() => { setSelected(0); }, [query]);

  const choose = (hit: QuickJumpHit) => {
    onOpenChange(false);
    if (hit.kind === 'page') onGoPage(hit.page);
    else if (hit.kind === 'resident') onOpenResident(hit.resident);
    else onOpenTransaction(hit.transaction);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!hits.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((current) => (current + 1) % hits.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((current) => (current - 1 + hits.length) % hits.length); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(hits[Math.min(selected, hits.length - 1)]); }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="560px" aria-describedby={undefined} onKeyDown={handleKeyDown}>
        <Dialog.Title size="3" mb="2">Quick jump</Dialog.Title>
        <TextField.Root autoFocus size="2" placeholder="Search residents, cards, entry codes, phones, notes, or pages…"
          value={query} onChange={(event) => setQuery(event.target.value)} />
        <Box mt="3" style={{ maxHeight: 360, overflowY: 'auto' }}>
          {hits.length === 0 ? (
            <Text size="2" color="gray">No matches.</Text>
          ) : (
            <Flex direction="column" gap="1">
              {hits.map((hit, index) => {
                const active = index === selected;
                const badge = KIND_BADGE[hit.kind];
                return (
                  <Flex key={hit.id} align="center" justify="between" gap="2" px="2" py="2"
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => choose(hit)}
                    style={{
                      cursor: 'pointer',
                      borderRadius: 'var(--radius-2)',
                      background: active ? 'var(--accent-a4)' : undefined,
                    }}>
                    <Flex direction="column" style={{ minWidth: 0 }}>
                      <Text size="2" weight="medium" truncate>{hit.title}</Text>
                      <Text size="1" color="gray" truncate>{hit.subtitle}</Text>
                    </Flex>
                    <Badge size="1" color={badge.color}>{badge.label}</Badge>
                  </Flex>
                );
              })}
            </Flex>
          )}
        </Box>
      </Dialog.Content>
    </Dialog.Root>
  );
}
