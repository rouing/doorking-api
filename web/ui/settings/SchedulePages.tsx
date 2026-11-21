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

// Hold Open: begin/end times and days per row (7 rows + Holiday), and which relays each row holds open. The relay
// columns are stored per relay as one flag per row. shown: relays 0-2 plus the Tracker relays.
export function HoldOpenPage({ gapi, relays: shown }: { gapi: GateApi; relays: number[] }) {
  const settings = useGateSettings(gapi);
  const f = (label: string, part: string) => settings.field(`holdOpen${label}${part}`);
  const relays = shown.map((r) => f('Relay', String(r)));
  return (
    <GroupPage gs={settings} group="Hold Open" title="Hold Open" help="holdOpen" clearValue={holdOpenClear(shown)}
      intro={`Set begin/end times and days for each schedule row (7 rows + the Holiday row), and which relays (${relayRanges(shown)}) it holds open. Leave a row's times blank to disable it. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Row', 'Begin', 'End', ...DAY_LETTERS, ...shown.map(String), 'Status']} />
      <Table.Body>
        {['1', '2', '3', '4', '5', '6', '7', 'Hol'].map((label, ri) => {
          const begin = f(label, 'Begin'); const end = f(label, 'End'); const days = f(label, 'Days');
          if (!begin || !end || !days) return null;
          const relayEdited = relays.some((relay) => relay && settings.current(relay)[ri] !== relay.value[ri]);
          const relayPending = relays.some((relay) => relay && relay.value[ri] !== relay.gate[ri]);
          const own = [begin, end, days];
          const st = rowState(settings, own, own.some((setting) => setting.key in settings.edits) || relayEdited,
            own.some((setting) => setting.value !== setting.gate) || relayPending);
          return (
            <Table.Row key={label} style={st.style}>
              <Table.RowHeaderCell>{label}</Table.RowHeaderCell>
              <Table.Cell><TimeBox value={settings.current(begin)} onChange={(v) => settings.edit(begin, v)} /></Table.Cell>
              <Table.Cell><TimeBox value={settings.current(end)} onChange={(v) => settings.edit(end, v)} /></Table.Cell>
              {DAY_LETTERS.map((_, d) => (
                <Table.Cell key={d}><Box checked={settings.current(days)[d] === '1'} onChange={(on) => settings.edit(days, setBit(settings.current(days), d, on))} /></Table.Cell>
              ))}
              {relays.map((relay, i) => (
                <Table.Cell key={i}>{relay && <Box checked={settings.current(relay)[ri] === '1'} onChange={(on) => settings.edit(relay, setBit(settings.current(relay), ri, on))} />}</Table.Cell>
              ))}
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

// Elevator Reference table (DoorKing manual 4.3): for each of the 8 references (ER1-ER8), which elevators (1-8) a
// visitor may use and how long the resident's floor button stays active, in seconds. A resident's Elevator
// reference picks the row.
export function ElevatorPage({ gapi }: { gapi: GateApi }) {
  const settings = useGateSettings(gapi);
  return (
    <GroupPage gs={settings} group="Elevator" title="Elevator Reference" help="elevatorReference" clearValue={(setting) => (setting.key.endsWith('Elevators') ? '00000000' : '')}
      intro={`When a resident lets a visitor in, the visitor can use only the elevators checked in the resident's Elevator reference row, and only the resident's floor button works, for the time set here (seconds, counted once the elevator reaches the ground floor). ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Reference', ...Array.from({ length: 8 }, (_, e) => String(e + 1)), 'Floor button (s)', 'Status']} />
      <Table.Body>
        {Array.from({ length: 8 }, (_, i) => i + 1).map((r) => {
          const elevs = settings.field(`elevator${r}Elevators`); const time = settings.field(`elevator${r}Time`);
          if (!elevs || !time) return null;
          const st = rowState(settings, [elevs, time]);
          return (
            <Table.Row key={r} style={st.style}>
              <Table.RowHeaderCell>ER{r}</Table.RowHeaderCell>
              {Array.from({ length: 8 }, (_, e) => (
                <Table.Cell key={e}><Box checked={settings.current(elevs)[e] === '1'} onChange={(on) => settings.edit(elevs, setBit(settings.current(elevs), e, on))} /></Table.Cell>
              ))}
              <Table.Cell><TextField.Root size="1" type="number" min={0} max={254} style={{ width: '8ch' }} value={settings.current(time)}
                onChange={(event) => settings.edit(time, event.target.value.trim())} /></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

// Relay / Elevator table: which elevators (1-8) each relay controls. Relays 0-2, plus 3-10 / 11-18 with the Tracker
// boxes; hidden relays are left as they are.
export function RelayElevatorPage({ gapi, prefs }: { gapi: GateApi; prefs: GatePrefs }) {
  const settings = useGateSettings(gapi);
  const relays = trackerRelays(trackerOf(prefs));
  const label = (r: number) => prefs.relayLabels?.[String(r)];
  return (
    <GroupPage gs={settings} group="Relay Elevator" title="Relay / Elevator" help="relayElevator"
      clearValue={(setting) => (relays.includes(Number(/^relay(\d+)Elevators$/.exec(setting.key)?.[1])) ? '00000000' : undefined)}
      intro={`Check which elevators (1–8) each relay controls. Relays 3–18 show when their Tracker box is ticked on the Relays page. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Relay', ...Array.from({ length: 8 }, (_, e) => String(e + 1)), 'Status']} />
      <Table.Body>
        {relays.map((relay) => {
          const elevs = settings.field(`relay${relay}Elevators`);
          if (!elevs) return null;
          const st = rowState(settings, [elevs]);
          return (
            <Table.Row key={relay} style={st.style}>
              <Table.RowHeaderCell>{`Relay ${relay}${label(relay) && label(relay) !== `Relay ${relay}` ? ` (${label(relay)})` : ''}`}</Table.RowHeaderCell>
              {Array.from({ length: 8 }, (_, e) => (
                <Table.Cell key={e}><Box checked={settings.current(elevs)[e] === '1'} onChange={(on) => settings.edit(elevs, setBit(settings.current(elevs), e, on))} /></Table.Cell>
              ))}
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

// Security Levels: per level (02-30), each of its 4 time zones' begin/end times, days, relays and floors (the
// Floors column only when the gate's Floors feature is on). With Holidays for Security Levels on (working copy),
// TZ4 is the Holiday time zone and shows as HOL, as in DoorKing32. shown: relays 0-2 plus the Tracker relays.
export function SecurityPage({ gapi, floors: showFloors, relays: shown }: { gapi: GateApi; floors: boolean; relays: number[] }) {
  const settings = useGateSettings(gapi);
  const hol = settings.field(HOL_FOR_SL)?.value === 'Yes';
  const levels = [...new Set(settings.fields.filter((setting) => setting.group === 'Security').map((setting) => Number(/^sec(\d+)tz/.exec(setting.key)![1])))].sort((a, b) => a - b);
  const [picked, setPicked] = useState(2);
  const level = levels.includes(picked) ? picked : levels[0];
  const f = (tz: number, part: string) => settings.field(`sec${level}tz${tz}${part}`);
  const picker = levels.length > 0 && (
    <Choice title="Level" value={String(level)} onChange={(v) => setPicked(Number(v))}
      options={levels.map((l) => [String(l), `Level ${String(l).padStart(2, '0')}`] as const)} />
  );
  return (
    <GroupPage gs={settings} group="Security" title="Security Levels" help="security" buttons={picker}
      intro={`Pick a level (02–30) and edit each of its 4 time zones: begin/end times, days, ${showFloors
        ? `relays (${relayRanges(shown)}) and floors (comma-separated, 1–64)` : `and relays (${relayRanges(shown)})`}. ${hol
        ? 'Holidays for Security Levels is on (Holidays page), so TZ4 is the Holiday time zone (HOL): on a holiday it overrides the other time zones of the level. '
        : ''}${EDITS_NOTE}`}>
      <Head cols={['TZ', 'Begin', 'End', ...DAY_LETTERS, ...shown.map(String), ...(showFloors ? ['Floors'] : []), 'Status']} />
      <Table.Body>
        {[1, 2, 3, 4].map((tz) => {
          const begin = f(tz, 'Begin'); const end = f(tz, 'End'); const days = f(tz, 'Days'); const relays = f(tz, 'Relays'); const floors = f(tz, 'Floors');
          if (!begin || !end || !days || !relays || !floors) return null;
          const st = rowState(settings, [begin, end, days, relays, floors]);
          return (
            <Table.Row key={tz} style={st.style}>
              <Table.RowHeaderCell>{tz === 4 && hol ? 'HOL' : `TZ${tz}`}</Table.RowHeaderCell>
              <Table.Cell><TimeBox value={settings.current(begin)} onChange={(v) => settings.edit(begin, v)} /></Table.Cell>
              <Table.Cell><TimeBox value={settings.current(end)} onChange={(v) => settings.edit(end, v)} /></Table.Cell>
              {DAY_LETTERS.map((_, d) => (
                <Table.Cell key={d}><Box checked={settings.current(days)[d] === '1'} onChange={(on) => settings.edit(days, setBit(settings.current(days), d, on))} /></Table.Cell>
              ))}
              {shown.map((r) => (
                <Table.Cell key={r}><Box checked={settings.current(relays)[r] === '1'} onChange={(on) => settings.edit(relays, setBit(settings.current(relays), r, on))} /></Table.Cell>
              ))}
              {showFloors && (
                <Table.Cell><TextField.Root size="1" placeholder="e.g. 1,8" style={{ width: '12ch' }} value={settings.current(floors)}
                  onChange={(event) => settings.edit(floors, event.target.value.trim())} /></Table.Cell>
              )}
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
