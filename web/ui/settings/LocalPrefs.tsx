import { useEffect, useState } from 'react';
import { Button, Card, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { DeviceRange, GatePrefs } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { DEFAULT_DEVICE_ASSOCIATION } from '../../../src/shared.ts';
import { HelpTip } from '../HelpTip.tsx';

interface RelayNameBoxProps {
  relay: number;
  prefs: GatePrefs;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

/**
 * The name of one relay (a box in the Relays page's relay settings table). Saved on its own when the box loses
 * focus or on Enter; blank goes back to "Relay N". Shared by every account that manages the gate; not sent to it.
 *
 * @param props - Component props.
 * @param props.relay - Relay.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onSaved - On saved.
 * @returns Rendered React element.
 */
export function RelayNameBox({ relay, prefs, gapi, onSaved }: RelayNameBoxProps) {
  const k = String(relay);
  const saved = (prefs.relayLabels && prefs.relayLabels[k]) || `Relay ${k}`;
  const [value, setValue] = useState(saved);
  const [info, setInfo] = useState('');
  useEffect(() => { setValue(saved); }, [saved]);
  const save = async () => {
    const next = value.trim() || `Relay ${k}`;
    setValue(next);
    if (next === saved) return;
    setInfo('Saving…');
    try {
      await gapi('PUT', '/prefs', { relayLabels: { [k]: next } });
      setInfo('');
      await onSaved();
    } catch (err) { setInfo(`Not saved: ${errorText(err)}`); }
  };
  return (
    <TextField.Root size="1" maxLength={24} value={value} color={info.startsWith('Not') ? 'red' : undefined} style={{ width: '16ch' }}
      title={info || 'Relay name, saved when you leave the box. Shared by every account that manages this gate; not sent to the gate.'}
      onChange={(event) => setValue(event.target.value)} onBlur={save}
      onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
  );
}

interface DeviceAssociationProps {
  prefs: GatePrefs;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

/**
 * Device Association: names for ranges of device codes (00001-65407), up to 10 rows. The server checks names,
 * ranges and overlaps on save.
 *
 * @param props - Component props.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onSaved - On saved.
 * @returns Rendered React element.
 */
export function DeviceAssociation({ prefs, gapi, onSaved }: DeviceAssociationProps) {
  const fill = (list: DeviceRange[]) => Array.from({ length: 10 }, (_, i) => ({ ...(list[i] || { name: '', from: '', to: '' }) }));
  const [rows, setRows] = useState(() => fill(prefs.deviceAssociation || DEFAULT_DEVICE_ASSOCIATION));
  const [info, setInfo] = useState('');
  const set = (i: number, key: keyof DeviceRange, value: string) => setRows(rows.map((row, j) => (j === i ? { ...row, [key]: value } : row)));
  const save = async () => {
    setInfo('Saving…');
    try {
      const reply = await gapi<GatePrefs>('PUT', '/prefs', { deviceAssociation: rows.map((row) => ({ name: row.name.trim(), from: row.from.trim(), to: row.to.trim() })) });
      setRows(fill(reply.deviceAssociation || []));
      setInfo('Saved.');
      await onSaved(); // card transactions take their Event Type from these ranges
    } catch (err) { setInfo(`Save failed: ${errorText(err)}`); }
  };
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Heading size="3">Device association<HelpTip of="deviceAssociation" /></Heading>
        <Text size="2" color="gray">
          Names (up to 12 characters) for ranges of device codes (00001–65407), like DoorKing32's <em>Dev Enable</em> window. Up to 10 rows; ranges may not
          overlap. Stored locally and <strong>shared by every account that manages this gate</strong>. Not sent to the gate.
        </Text>
        <Table.Root size="1" style={{ width: 'fit-content' }}>
          <Table.Header>
            <Table.Row>{['#', 'Device Name', 'From', 'To'].map((header) => <Table.ColumnHeaderCell key={header}>{header}</Table.ColumnHeaderCell>)}</Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((row, i) => (
              <Table.Row key={i}>
                <Table.Cell>{i + 1}</Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={12} value={row.name} onChange={(event) => set(i, 'name', event.target.value)} /></Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={5} inputMode="numeric" value={row.from} onChange={(event) => set(i, 'from', event.target.value)} style={{ width: '8ch' }} /></Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={5} inputMode="numeric" value={row.to} onChange={(event) => set(i, 'to', event.target.value)} style={{ width: '8ch' }} /></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        <Flex gap="3" align="center" wrap="wrap"><Button onClick={save}>Save</Button><Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </Card>
  );
}
