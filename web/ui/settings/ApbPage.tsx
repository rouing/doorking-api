import type { ReactNode } from 'react';
import { Flex, RadioGroup, Table, Text, TextField } from '@radix-ui/themes';
import { Choice } from '../panes/fields.tsx';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { Box, DAY_LETTERS, GroupPage, Head, rowState, setBit, TimeBox } from './GroupPage.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

const MAX_RELAYS = 10;
/** Values Clear sets (every setting on the page back to unset). */
const CLEAR: Record<string, string> = {
  apbMode: 'Off', apbRelaysIn: '', apbRelaysOut: '', apbCounterEvery: 'Off', apbCounterReset: '', apbResyncAll: 'No',
  apbResyncList: '', apbScheduleEnabled: 'No', apbScheduleDays: '0000000', apbScheduleTime: '',
};
/** "?" tip of each row (a key in HELP). */
const ROW_HELP: Record<string, string> = {
  'True Anti Passback': 'apbMode', 'Relays In': 'apbRelays', 'Relays Out': 'apbRelays', 'Record Facility Counter Every': 'apbCounter',
  'Reset Facility Counter to': 'apbCounter', 'Re-Sync': 'apbResync', 'Enable Scheduled Re-Sync All': 'apbResync',
};

interface GateChoiceProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}

/**
 * The gate's own value stays in the list even when it isn't one of the usual ones.
 *
 * @param props - Component props.
 * @param props.value - Input value.
 * @param props.options - Optional settings.
 * @param props.onChange - Callback invoked when the value changes.
 * @returns Rendered React element.
 */
function GateChoice({ value, options, onChange }: GateChoiceProps) {
  return <Choice size="1" value={value} options={options.includes(value) ? options : [...options, value]} onChange={onChange} />;
}

interface RelayPicksProps {
  settings: GateSettings;
  setting: GateSettingRow;
  name: (relay: number) => string;
  shown: number[];
}

/**
 * In/Out relays: checkboxes for the shown relays; hidden relays already set are kept. At most 10 in total.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.setting - Setting.
 * @param props.name - Display name or filename.
 * @param props.shown - Shown.
 * @returns Rendered React element.
 */
function RelayPicks({ settings, setting, name, shown }: RelayPicksProps) {
  const on = new Set(settings.current(setting).split(',').filter(Boolean).map(Number));
  const set = (relay: number, picked: boolean) => {
    on.delete(relay);
    if (picked) on.add(relay);
    settings.edit(setting, [...on].sort((a, b) => a - b).join(','));
  };
  return (
    <Flex gap="3" wrap="wrap">
      {shown.map((relay) => <Box key={relay} label={name(relay)} checked={on.has(relay)} disabled={!on.has(relay) && on.size >= MAX_RELAYS} onChange={(on) => set(relay, on)} />)}
    </Flex>
  );
}

interface ResyncProps {
  settings: GateSettings;
  all: GateSettingRow;
  list: GateSettingRow;
}

/**
 * Re-Sync: none, all devices, or a list of up to 5 device numbers.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.all - All.
 * @param props.list - List of input items.
 * @returns Rendered React element.
 */
function Resync({ settings, all, list }: ResyncProps) {
  const cur = settings.current(list);
  const mode = cur !== '' ? 'list' : settings.current(all) === 'Yes' ? 'all' : 'none';
  const slots = (cur || ',,,,').split(',');
  const setMode = (mode: string) => {
    settings.edit(all, mode === 'all' ? 'Yes' : 'No');
    settings.edit(list, mode === 'list' ? (cur || ',,,,') : '');
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
            onChange={(event) => { const next = Array.from({ length: 5 }, (__, j) => slots[j] ?? ''); next[i] = event.target.value.trim(); settings.edit(list, next.join(',')); }} />
        ))}
      </Flex>
    </Flex>
  );
}

interface ApbPageProps {
  gapi: GateApi;
  relayLabels: Record<string, string | undefined>;
  relays: number[];
}

/**
 * Anti-Pass Back (names.bin block 20): mode, In/Out relays, facility counter, one-time re-sync and the scheduled
 * Re-Sync All. shown: relays 0-2 plus the Tracker relays.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.relayLabels - Relay labels.
 * @param props.relays - Relays.
 * @returns Rendered React element.
 */
export function ApbPage({ gapi, relayLabels, relays: shown }: ApbPageProps) {
  const settings = useGateSettings(gapi);
  const field = (key: string) => settings.field(key);
  const name = (relay: number) => (relayLabels[relay] && relayLabels[relay] !== `Relay ${relay}` ? relayLabels[relay]! : String(relay));
  const rows: [string, (GateSettingRow | undefined)[], (fs: GateSettingRow[]) => ReactNode][] = [
    ['True Anti Passback', [field('apbMode')], ([setting]) => <GateChoice value={settings.current(setting)} options={['Off', 'Passive', 'Active', 'Trap']} onChange={(value) => settings.edit(setting, value)} />],
    ['Relays In', [field('apbRelaysIn')], ([setting]) => <RelayPicks settings={settings} setting={setting} name={name} shown={shown} />],
    ['Relays Out', [field('apbRelaysOut')], ([setting]) => <RelayPicks settings={settings} setting={setting} name={name} shown={shown} />],
    ['Record Facility Counter Every', [field('apbCounterEvery')], ([setting]) => <GateChoice value={settings.current(setting)} options={['Off', '15 Mins', '30 Mins', 'Hour']} onChange={(value) => settings.edit(setting, value)} />],
    ['Reset Facility Counter to', [field('apbCounterReset')], ([setting]) => <TextField.Root size="1" type="number" min={0} max={65535} style={{ width: '10ch' }}
      value={settings.current(setting)} onChange={(event) => settings.edit(setting, event.target.value.trim())} />],
    ['Re-Sync', [field('apbResyncAll'), field('apbResyncList')], ([a, setting]) => <Resync settings={settings} all={a} list={setting} />],
    ['Enable Scheduled Re-Sync All', [field('apbScheduleEnabled')], ([setting]) => <Box checked={settings.current(setting) === 'Yes'} onChange={(on) => settings.edit(setting, on ? 'Yes' : 'No')} />],
    ['Scheduled Re-Sync All days', [field('apbScheduleDays')], ([setting]) => (
      <Flex gap="2">{DAY_LETTERS.map((letter, i) => <Box key={i} label={letter} checked={settings.current(setting)[i] === '1'} onChange={(on) => settings.edit(setting, setBit(settings.current(setting), i, on))} />)}</Flex>
    )],
    ['Scheduled Re-Sync All time', [field('apbScheduleTime')], ([setting]) => <TimeBox value={settings.current(setting)} onChange={(value) => settings.edit(setting, value)} />],
  ];
  return (
    <GroupPage settings={settings} group="Anti-Pass Back" title="Anti-Pass Back" help="apb" clearValue={(setting) => CLEAR[setting.key]}
      intro="Set the anti-pass back mode, In/Out relays (up to 10 each), facility counter, one-time re-sync functions and the scheduled Re-Sync All. Anti-pass back applies only to cards in security levels 02–27; levels 01, 28, 29 and 30 are never limited by it. Clear sets every setting on this page back to unset. Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).">
      <Head cols={['Setting', 'Value', 'Status']} />
      <Table.Body>
        {rows.map(([label, fs, build]) => {
          if (fs.some((setting) => !setting)) return null;
          const row = rowState(settings, fs, { pendingText: 'saved, not sent' });
          return (
            <Table.Row key={label} style={row.style}>
              <Table.Cell>{label}{ROW_HELP[label] && <HelpTip of={ROW_HELP[label]} />}</Table.Cell>
              <Table.Cell>{build(fs as GateSettingRow[])}</Table.Cell>
              <Table.Cell><Text size="1" color="gray">{row.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
