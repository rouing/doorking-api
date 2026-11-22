import { useState } from 'react';
import { DropdownMenu, Flex, Text } from '@radix-ui/themes';
import { CheckIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import type { GateInfo } from '../../../src/types.ts';
import { api, errorText } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { gateLabel, roleLabel } from '../Gates.tsx';

interface GateSwitcherProps {
  gate: GateInfo; // the open gate
  onSwitch: (to: GateInfo) => void;
  onAllGates: () => void;
}

// The gate's name in the sidebar (and the phone's menu): opens a list of the user's gates to switch to, and All gates.
export function GateSwitcher({ gate, onSwitch, onAllGates }: GateSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [gates, setGates] = useState<GateInfo[] | null>(null);
  const [error, setError] = useState('');
  useBackLayer(open, () => setOpen(false));
  const toggle = (next: boolean) => {
    setOpen(next);
    if (next) api<{ gates: GateInfo[] }>('GET', '/api/gates').then((reply) => { setGates(reply.gates); setError(''); }, (err) => setError(errorText(err)));
  };
  return (
    <DropdownMenu.Root open={open} onOpenChange={toggle}>
      <DropdownMenu.Trigger>
        <button type="button" className="gate-switcher" aria-label={`${gateLabel(gate)}: switch gate`}>
          <Text size="3" weight="bold" style={{ overflowWrap: 'anywhere' }}>{gateLabel(gate)}</Text>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" style={{ minWidth: 220, maxWidth: 'min(360px, 90vw)' }}>
        <DropdownMenu.Label>Your gates</DropdownMenu.Label>
        {!gates && !error && <DropdownMenu.Item disabled>Loading…</DropdownMenu.Item>}
        {error && <DropdownMenu.Item disabled>{error}</DropdownMenu.Item>}
        {gates?.map((other) => (
          <DropdownMenu.Item key={other.phoneNumber} onSelect={() => { if (other.phoneNumber !== gate.phoneNumber) onSwitch(other); }}>
            <Flex align="center" gap="2" width="100%">
              <span style={{ width: 15, display: 'inline-flex' }}>{other.phoneNumber === gate.phoneNumber && <CheckIcon aria-label="Open now" />}</span>
              <Text truncate>{gateLabel(other)}</Text>
              <Flex flexGrow="1" />
              {other.role !== 'admin' && <Text size="1" color="gray">{roleLabel(other.role)}</Text>}
            </Flex>
          </DropdownMenu.Item>
        ))}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={onAllGates}>All gates…</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

