import { useState } from 'react';
import { Table, Text, TextField } from '@radix-ui/themes';
import { Choice } from '../panes/fields.tsx';
import type { GatePrefs, GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { trackerOf, trackerRelays } from '../format.ts';
import { Box, CLEAR_NOTE, DAY_LETTERS, GroupPage, Head, rowState, setBit, TimeBox } from './GroupPage.tsx';
import { useGateSettings } from './useGateSettings.ts';
import { HOL_FOR_SL } from './ListPages.tsx';

const EDITS_NOTE = 'Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).';

// The shown relays as ranges, e.g. "0–2" or "0–10".
const relayRanges = (relays: number[]) => relays.reduce<number[][]>((ranges, relay) => {
  const last = ranges[ranges.length - 1];
  if (last && relay === last[1] + 1) {
    last[1] = relay;
    return ranges;
  }
  ranges.push([relay, relay]);
  return ranges;
}, []).map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ');

// Hold Open unset: no times, no days, and the shown relays off for every row (hidden relays stay as they are).
const holdOpenClear = (shown: number[]) => (setting: GateSettingRow) => {
  if (setting.key.endsWith('Begin') || setting.key.endsWith('End')) return '';
  if (setting.key.endsWith('Days')) return '';
  const relay = /^holdOpenRelay(\d+)$/.exec(setting.key);
  return relay && shown.includes(Number(relay[1])) ? '00000000' : undefined;
};

interface HoldOpenPageProps {
  gapi: GateApi;
  relays: number[];
}

// Hold Open: begin/end times and days per row (7 rows + Holiday), and which relays each row holds open. The relay
// columns are stored per relay as one flag per row. shown: relays 0-2 plus the Tracker relays.
export function HoldOpenPage({ gapi, relays: shown }: HoldOpenPageProps) {
  const settings = useGateSettings(gapi);
  const field = (label: string, part: string) => settings.field(`holdOpen${label}${part}`);
  const relays = shown.map((relay) => field('Relay', String(relay)));
  return (
    <GroupPage settings={settings} group="Hold Open" title="Hold Open" help="holdOpen" clearValue={holdOpenClear(shown)}
      intro={`Set begin/end times and days for each schedule row (7 rows + the Holiday row), and which relays (${relayRanges(shown)}) it holds open. Leave a row's times blank to disable it. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Row', 'Begin', 'End', ...DAY_LETTERS, ...shown.map(String), 'Status']} />
      <Table.Body>
        {['1', '2', '3', '4', '5', '6', '7', 'Hol'].map((label, rowIndex) => {
          const begin = field(label, 'Begin'); const end = field(label, 'End'); const days = field(label, 'Days');
          if (!begin || !end || !days) return null;
          const relayEdited = relays.some((relay) => relay && settings.current(relay)[rowIndex] !== relay.value[rowIndex]);
          const relayPending = relays.some((relay) => relay && relay.value[rowIndex] !== relay.gate[rowIndex]);
          const own = [begin, end, days];
          const row = rowState(settings, own, { edited: own.some((setting) => setting.key in settings.edits) || relayEdited,
            pending: own.some((setting) => setting.value !== setting.gate) || relayPending });
          return (
            <Table.Row key={label} style={row.style}>
              <Table.RowHeaderCell>{label}</Table.RowHeaderCell>
              <Table.Cell><TimeBox value={settings.current(begin)} onChange={(value) => settings.edit(begin, value)} /></Table.Cell>
              <Table.Cell><TimeBox value={settings.current(end)} onChange={(value) => settings.edit(end, value)} /></Table.Cell>
              {DAY_LETTERS.map((_, day) => (
                <Table.Cell key={day}><Box checked={settings.current(days)[day] === '1'} onChange={(on) => settings.edit(days, setBit(settings.current(days), day, on))} /></Table.Cell>
              ))}
              {relays.map((relay, i) => (
                <Table.Cell key={i}>{relay && <Box checked={settings.current(relay)[rowIndex] === '1'} onChange={(on) => settings.edit(relay, setBit(settings.current(relay), rowIndex, on))} />}</Table.Cell>
              ))}
              <Table.Cell><Text size="1" color="gray">{row.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

interface ElevatorPageProps {
  gapi: GateApi;
}

// Elevator Reference table (DoorKing manual 4.3): for each of the 8 references (ER1-ER8), which elevators (1-8) a
// visitor may use and how long the resident's floor button stays active, in seconds. A resident's Elevator
// reference picks the row.
export function ElevatorPage({ gapi }: ElevatorPageProps) {
  const settings = useGateSettings(gapi);
  return (
    <GroupPage settings={settings} group="Elevator" title="Elevator Reference" help="elevatorReference" clearValue={(setting) => (setting.key.endsWith('Elevators') ? '00000000' : '')}
      intro={`When a resident lets a visitor in, the visitor can use only the elevators checked in the resident's Elevator reference row, and only the resident's floor button works, for the time set here (seconds, counted once the elevator reaches the ground floor). ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Reference', ...Array.from({ length: 8 }, (_, elevator) => String(elevator + 1)), 'Floor button (s)', 'Status']} />
      <Table.Body>
        {Array.from({ length: 8 }, (_, i) => i + 1).map((reference) => {
          const elevs = settings.field(`elevator${reference}Elevators`); const time = settings.field(`elevator${reference}Time`);
          if (!elevs || !time) return null;
          const row = rowState(settings, [elevs, time]);
          return (
            <Table.Row key={reference} style={row.style}>
              <Table.RowHeaderCell>ER{reference}</Table.RowHeaderCell>
              {Array.from({ length: 8 }, (_, elevator) => (
                <Table.Cell key={elevator}><Box checked={settings.current(elevs)[elevator] === '1'} onChange={(on) => settings.edit(elevs, setBit(settings.current(elevs), elevator, on))} /></Table.Cell>
              ))}
              <Table.Cell><TextField.Root size="1" type="number" min={0} max={254} style={{ width: '8ch' }} value={settings.current(time)}
                onChange={(event) => settings.edit(time, event.target.value.trim())} /></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{row.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

interface RelayElevatorPageProps {
  gapi: GateApi;
  prefs: GatePrefs;
}

// Relay / Elevator table: which elevators (1-8) each relay controls. Relays 0-2, plus 3-10 / 11-18 with the Tracker
// boxes; hidden relays are left as they are.
export function RelayElevatorPage({ gapi, prefs }: RelayElevatorPageProps) {
  const settings = useGateSettings(gapi);
  const relays = trackerRelays(trackerOf(prefs));
  const label = (relay: number) => prefs.relayLabels?.[String(relay)];
  return (
    <GroupPage settings={settings} group="Relay Elevator" title="Relay / Elevator" help="relayElevator"
      clearValue={(setting) => (relays.includes(Number(/^relay(\d+)Elevators$/.exec(setting.key)?.[1])) ? '00000000' : undefined)}
      intro={`Check which elevators (1–8) each relay controls. Relays 3–18 show when their Tracker box is ticked on the Relays page. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Relay', ...Array.from({ length: 8 }, (_, elevator) => String(elevator + 1)), 'Status']} />
      <Table.Body>
        {relays.map((relay) => {
          const elevs = settings.field(`relay${relay}Elevators`);
          if (!elevs) return null;
          const row = rowState(settings, [elevs]);
          return (
            <Table.Row key={relay} style={row.style}>
              <Table.RowHeaderCell>{`Relay ${relay}${label(relay) && label(relay) !== `Relay ${relay}` ? ` (${label(relay)})` : ''}`}</Table.RowHeaderCell>
              {Array.from({ length: 8 }, (_, elevator) => (
                <Table.Cell key={elevator}><Box checked={settings.current(elevs)[elevator] === '1'} onChange={(on) => settings.edit(elevs, setBit(settings.current(elevs), elevator, on))} /></Table.Cell>
              ))}
              <Table.Cell><Text size="1" color="gray">{row.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

interface SecurityPageProps {
  gapi: GateApi;
  floors: boolean;
  relays: number[];
}

// Security Levels: per level (02-30), each of its 4 time zones' begin/end times, days, relays and floors (the
// Floors column only when the gate's Floors feature is on). With Holidays for Security Levels on (working copy),
// TZ4 is the Holiday time zone and shows as HOL, as in DoorKing32. shown: relays 0-2 plus the Tracker relays.
export function SecurityPage({ gapi, floors: showFloors, relays: shown }: SecurityPageProps) {
  const settings = useGateSettings(gapi);
  const hol = settings.field(HOL_FOR_SL)?.value === 'Yes';
  const levels = [...new Set(settings.fields.filter((setting) => setting.group === 'Security').map((setting) => Number(/^sec(\d+)tz/.exec(setting.key)![1])))].sort((a, b) => a - b);
  const [picked, setPicked] = useState(2);
  const level = levels.includes(picked) ? picked : levels[0];
  const field = (tz: number, part: string) => settings.field(`sec${level}tz${tz}${part}`);
  const picker = levels.length > 0 && (
    <Choice title="Level" value={String(level)} onChange={(value) => setPicked(Number(value))}
      options={levels.map((level) => [String(level), `Level ${String(level).padStart(2, '0')}`] as const)} />
  );
  return (
    <GroupPage settings={settings} group="Security" title="Security Levels" help="security" buttons={picker}
      intro={`Pick a level (02–30) and edit each of its 4 time zones: begin/end times, days, ${showFloors
        ? `relays (${relayRanges(shown)}) and floors (comma-separated, 1–64)` : `and relays (${relayRanges(shown)})`}. ${hol
        ? 'Holidays for Security Levels is on (Holidays page), so TZ4 is the Holiday time zone (HOL): on a holiday it overrides the other time zones of the level. '
        : ''}${EDITS_NOTE}`}>
      <Head cols={['TZ', 'Begin', 'End', ...DAY_LETTERS, ...shown.map(String), ...(showFloors ? ['Floors'] : []), 'Status']} />
      <Table.Body>
        {[1, 2, 3, 4].map((tz) => {
          const begin = field(tz, 'Begin'); const end = field(tz, 'End'); const days = field(tz, 'Days'); const relays = field(tz, 'Relays'); const floors = field(tz, 'Floors');
          if (!begin || !end || !days || !relays || !floors) return null;
          const row = rowState(settings, [begin, end, days, relays, floors]);
          return (
            <Table.Row key={tz} style={row.style}>
              <Table.RowHeaderCell>{tz === 4 && hol ? 'HOL' : `TZ${tz}`}</Table.RowHeaderCell>
              <Table.Cell><TimeBox value={settings.current(begin)} onChange={(value) => settings.edit(begin, value)} /></Table.Cell>
              <Table.Cell><TimeBox value={settings.current(end)} onChange={(value) => settings.edit(end, value)} /></Table.Cell>
              {DAY_LETTERS.map((_, day) => (
                <Table.Cell key={day}><Box checked={settings.current(days)[day] === '1'} onChange={(on) => settings.edit(days, setBit(settings.current(days), day, on))} /></Table.Cell>
              ))}
              {shown.map((relay) => (
                <Table.Cell key={relay}><Box checked={settings.current(relays)[relay] === '1'} onChange={(on) => settings.edit(relays, setBit(settings.current(relays), relay, on))} /></Table.Cell>
              ))}
              {showFloors && (
                <Table.Cell><TextField.Root size="1" placeholder="e.g. 1,8" style={{ width: '12ch' }} value={settings.current(floors)}
                  onChange={(event) => settings.edit(floors, event.target.value.trim())} /></Table.Cell>
              )}
              <Table.Cell><Text size="1" color="gray">{row.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
