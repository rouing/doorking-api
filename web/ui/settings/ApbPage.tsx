import type { ReactNode } from 'react';
import { Flex, RadioGroup, Table, Text, TextField } from '@radix-ui/themes';
import { Choice } from '../panes/fields.tsx';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { Box, DAY_LETTERS, GroupPage, Head, rowState, setBit, TimeBox } from './GroupPage.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

const MAX_RELAYS = 10;
// Values Clear sets (every setting on the page back to unset).
const CLEAR: Record<string, string> = {
  apbMode: 'Off', apbRelaysIn: '', apbRelaysOut: '', apbCounterEvery: 'Off', apbCounterReset: '', apbResyncAll: 'No',
  apbResyncList: '', apbScheduleEnabled: 'No', apbScheduleDays: '0000000', apbScheduleTime: '',
};
// "?" tip of each row (a key in HELP).
const ROW_HELP: Record<string, string> = {
  'True Anti Passback': 'apbMode', 'Relays In': 'apbRelays', 'Relays Out': 'apbRelays', 'Record Facility Counter Every': 'apbCounter',
  'Reset Facility Counter to': 'apbCounter', 'Re-Sync': 'apbResync', 'Enable Scheduled Re-Sync All': 'apbResync',
};

// The gate's own value stays in the list even when it isn't one of the usual ones.
function GateChoice({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return <Choice size="1" value={value} options={options.includes(value) ? options : [...options, value]} onChange={onChange} />;
}

// In/Out relays: checkboxes for the shown relays; hidden relays already set are kept. At most 10 in total.
function RelayPicks({ gs: settings, f: setting, name, shown }: { gs: GateSettings; f: GateSettingRow; name: (r: number) => string; shown: number[] }) {
  const on = new Set(settings.current(setting).split(',').filter(Boolean).map(Number));
  const set = (relay: number, picked: boolean) => {
    on.delete(relay);
    if (picked) on.add(relay);
    settings.edit(setting, [...on].sort((a, b) => a - b).join(','));
  };
  return (
    <Flex gap="3" wrap="wrap">
      {shown.map((r) => <Box key={r} label={name(r)} checked={on.has(r)} disabled={!on.has(r) && on.size >= MAX_RELAYS} onChange={(v) => set(r, v)} />)}
    </Flex>
  );
}

// Re-Sync: none, all devices, or a list of up to 5 device numbers.
function Resync({ gs: settings, all, list }: { gs: GateSettings; all: GateSettingRow; list: GateSettingRow }) {
  const cur = settings.current(list);
  const mode = cur !== '' ? 'list' : settings.current(all) === 'Yes' ? 'all' : 'none';
  const slots = (cur || ',,,,').split(',');
  const setMode = (m: string) => {
    settings.edit(all, m === 'all' ? 'Yes' : 'No');
    settings.edit(list, m === 'list' ? (cur || ',,,,') : '');
  };
  return (
    <Flex direction="column" gap="2">
      <RadioGroup.Root size="1" value={mode} onValueChange={setMode}>
        <Flex gap="3"><RadioGroup.Item value="none">None</RadioGroup.Item><RadioGroup.Item value="all">Re-Sync All Devices</RadioGroup.Item>
          <RadioGroup.Item value="list">Enable Re-Sync List</RadioGroup.Item></Flex>
      </RadioGroup.Root>
      <Flex gap="1">
        {Array.from({ length: 5 }, (_, i) => (
          <TextField.Root key={i} size="1" type="number" min={1} max={65535} style={{ width: '9ch' }} disabled={mode !== 'list'} value={slots[i] ?? ''}
            onChange={(event) => { const s = Array.from({ length: 5 }, (__, j) => slots[j] ?? ''); s[i] = event.target.value.trim(); settings.edit(list, s.join(',')); }} />
        ))}
      </Flex>
    </Flex>
  );
}

// Anti-Pass Back (names.bin block 20): mode, In/Out relays, facility counter, one-time re-sync and the scheduled
// Re-Sync All. shown: relays 0-2 plus the Tracker relays.
export function ApbPage({ gapi, relayLabels, relays: shown }: { gapi: GateApi; relayLabels: Record<string, string | undefined>; relays: number[] }) {
  const settings = useGateSettings(gapi);
  const f = (k: string) => settings.field(k);
  const name = (r: number) => (relayLabels[r] && relayLabels[r] !== `Relay ${r}` ? relayLabels[r]! : String(r));
  const rows: [string, (GateSettingRow | undefined)[], (fs: GateSettingRow[]) => ReactNode][] = [
    ['True Anti Passback', [f('apbMode')], ([setting]) => <GateChoice value={settings.current(setting)} options={['Off', 'Passive', 'Active', 'Trap']} onChange={(v) => settings.edit(setting, v)} />],
    ['Relays In', [f('apbRelaysIn')], ([setting]) => <RelayPicks gs={settings} f={setting} name={name} shown={shown} />],
    ['Relays Out', [f('apbRelaysOut')], ([setting]) => <RelayPicks gs={settings} f={setting} name={name} shown={shown} />],
    ['Record Facility Counter Every', [f('apbCounterEvery')], ([setting]) => <GateChoice value={settings.current(setting)} options={['Off', '15 Mins', '30 Mins', 'Hour']} onChange={(v) => settings.edit(setting, v)} />],
    ['Reset Facility Counter to', [f('apbCounterReset')], ([setting]) => <TextField.Root size="1" type="number" min={0} max={65535} style={{ width: '10ch' }}
      value={settings.current(setting)} onChange={(event) => settings.edit(setting, event.target.value.trim())} />],
    ['Re-Sync', [f('apbResyncAll'), f('apbResyncList')], ([a, setting]) => <Resync gs={settings} all={a} list={setting} />],
    ['Enable Scheduled Re-Sync All', [f('apbScheduleEnabled')], ([setting]) => <Box checked={settings.current(setting) === 'Yes'} onChange={(on) => settings.edit(setting, on ? 'Yes' : 'No')} />],
    ['Scheduled Re-Sync All days', [f('apbScheduleDays')], ([setting]) => (
      <Flex gap="2">{DAY_LETTERS.map((letter, i) => <Box key={i} label={letter} checked={settings.current(setting)[i] === '1'} onChange={(on) => settings.edit(setting, setBit(settings.current(setting), i, on))} />)}</Flex>
    )],
    ['Scheduled Re-Sync All time', [f('apbScheduleTime')], ([setting]) => <TimeBox value={settings.current(setting)} onChange={(v) => settings.edit(setting, v)} />],
  ];
  return (
    <GroupPage gs={settings} group="Anti-Pass Back" title="Anti-Pass Back" help="apb" clearValue={(setting) => CLEAR[setting.key]}
      intro="Set the anti-pass back mode, In/Out relays (up to 10 each), facility counter, one-time re-sync functions and the scheduled Re-Sync All. Anti-pass back applies only to cards in security levels 02–27; levels 01, 28, 29 and 30 are never limited by it. Clear sets every setting on this page back to unset. Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).">
      <Head cols={['Setting', 'Value', 'Status']} />
      <Table.Body>
        {rows.map(([label, fs, build]) => {
          if (fs.some((x) => !x)) return null;
          const st = rowState(settings, fs, undefined, undefined, 'saved, not sent');
          return (
            <Table.Row key={label} style={st.style}>
              <Table.Cell>{label}{ROW_HELP[label] && <HelpTip of={ROW_HELP[label]} />}</Table.Cell>
              <Table.Cell>{build(fs as GateSettingRow[])}</Table.Cell>
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
