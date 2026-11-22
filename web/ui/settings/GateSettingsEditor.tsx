import type { ReactNode } from 'react';
import { Box as RadixBox, Callout, Flex, Grid, Heading, Table, Text } from '@radix-ui/themes';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { Box, setBit } from './GroupPage.tsx';
import { SettingInput, SettingsBar } from './SettingsBar.tsx';
import type { GateSettings } from './useGateSettings.ts';

/** Relay bitmask settings shown as a checkbox per relay (bit r = relay r). */
const RELAY_BITS: [string, string][] = [['relayPostalSwitch', 'Postal switch'], ['relayRotaryDial9', 'Rotary dial 9']];

/** Settings groups that have their own page (kept out of this editor). */
export const DEDICATED_GROUPS = new Set(['Holidays', 'Facility Codes', 'Hold Open', 'Elevator', 'Relay Elevator', 'Security', 'Anti-Pass Back']);

/**
 * Relays: one row per relay, one column per setting (strike time, the 4 open tones, entry code range, plus the
 * postal switch / rotary dial 9 checkboxes from RELAY_BITS).
 */
const RELAY_COLS: [string, string][] = [
  ['Time', 'Strike time (s)'], ['ToneMomentary', 'Momentary'], ['ToneHold', 'Hold'], ['ToneRelease', 'Release'],
  ['ToneHold1Hr', 'Hold 1 Hr'], ['EntryCodeRangeFrom', 'From'], ['EntryCodeRangeTo', 'To'],
];

interface FieldGridProps {
  settings: GateSettings;
  fields: GateSettingRow[];
}

function FieldGrid({ settings, fields }: FieldGridProps) {
  return (
    <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
      {fields.map((setting) => (
        <label key={setting.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Text size="2">{setting.name}<HelpTip of={setting.key} /></Text>
          <SettingInput settings={settings} setting={setting} />
          {setting.note && <Text size="1" color="gray">{setting.note}</Text>}
        </label>
      ))}
    </Grid>
  );
}

interface FieldRowsProps {
  settings: GateSettings;
  fields: GateSettingRow[];
}

/**
 * One row per setting: its name (and note) on the left, its box on the right.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.fields - Field names or field updates.
 * @returns Rendered React element.
 */
function FieldRows({ settings, fields }: FieldRowsProps) {
  return (
    <Table.Root size="1" variant="surface" style={{ width: 'fit-content', maxWidth: '100%' }}>
      <Table.Body>
        {fields.map((setting) => (
          <Table.Row key={setting.key} align="center">
            <Table.RowHeaderCell>
              <Text size="2" weight="regular">{setting.name}<HelpTip of={setting.key} /></Text>
              {setting.note && <Text as="div" size="1" color="gray">{setting.note}</Text>}
            </Table.RowHeaderCell>
            <Table.Cell><SettingInput settings={settings} setting={setting} /></Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

/**
 * Tone-open settings whose digit another tone also uses, and one line per clashing digit. Tracker command relays are
 * left out (their row is locked); the server refuses the same clashes.
 *
 * @param settings - Settings map or configuration.
 * @param locked - `Record<number, string>` value.
 * @returns `{ keys: Set<string>; lines: string[] }` result.
 */
function toneClashes(settings: GateSettings, locked: Record<number, string>): { keys: Set<string>; lines: string[] } {
  const uses = new Map<string, GateSettingRow[]>();
  for (const setting of settings.fields) {
    const match = /^relay(\d)Tone/.exec(setting.key);
    const v = settings.current(setting).trim();
    if (!match || !v || locked[Number(match[1])]) continue;
    uses.set(v, [...(uses.get(v) || []), setting]);
  }
  const clashes = [...uses].filter(([, list]) => list.length > 1);
  return {
    keys: new Set(clashes.flatMap(([, list]) => list.map((setting) => setting.key))),
    lines: clashes.map(([digit, list]) => `Digit ${digit}: ${list.map((setting) => setting.name.replace(' tone open: ', ' ')).join(', ')}`),
  };
}

interface RelayTableProps {
  settings: GateSettings;
  fields: GateSettingRow[];
  relayLabels: Record<string, string | undefined>;
  lockedRelays: Record<number, string>;
  relays: number[];
  nameCell?: (relay: number) => ReactNode;
  clash: { keys: Set<string>; lines: string[] };
}

/**
 * lockedRelays: relay -> note, for Tracker command relays. Their whole row is read-only: strike time fixed at 00, and
 * the tones, entry code range, postal switch and rotary dial 9 belong on relay 0 instead (DoorKing manual 3.1.3).
 * relays: the rows (0-2, plus the Tracker relays, which have only a name); nameCell: the name box of a relay.
 * clash: tone-open settings that share a digit (red).
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.fields - Field names or field updates.
 * @param props.relayLabels - Relay labels.
 * @param props.lockedRelays - Relay -> note, for Tracker command relays.
 * @param props.relays - Relay numbers to show (0–2, plus enabled Tracker relays 3–18).
 * @param props.nameCell - The name box of a relay.
 * @param props.clash - Set of tone-open setting keys that share a duplicate digit.
 * @returns Rendered React element.
 */
function RelayTable({ settings, fields, relayLabels, lockedRelays, relays, nameCell, clash }: RelayTableProps) {
  const byKey = new Map(fields.map((setting) => [setting.key, setting]));
  const used = new Set<string>();
  const label = (relay: number) => (relayLabels[relay] && relayLabels[relay] !== `Relay ${relay}` ? relayLabels[relay] : '');
  const span = RELAY_COLS.length + RELAY_BITS.length;
  const rows = relays.map((relay) => (relay > 2 ? (
    <Table.Row key={relay}>
      <Table.RowHeaderCell>Relay {relay}</Table.RowHeaderCell>
      <Table.Cell>{nameCell ? nameCell(relay) : label(relay)}</Table.Cell>
      <Table.Cell colSpan={span}><Text size="1" color="gray">Tracker relay ({relay <= 10 ? 'Tracker 2, commanded by relay 2' : 'Tracker 1, commanded by relay 1'}): times are set at the hardware</Text></Table.Cell>
    </Table.Row>
  ) : (
    <Table.Row key={relay}>
      <Table.RowHeaderCell>Relay {relay}</Table.RowHeaderCell>
      <Table.Cell>{nameCell ? nameCell(relay) : label(relay)}</Table.Cell>
      {RELAY_COLS.map(([suffix]) => {
        const setting = byKey.get(`relay${relay}${suffix}`);
        if (setting) used.add(setting.key);
        if (setting && lockedRelays[relay]) {
          const text = suffix === 'Time' ? '00' : settings.current(setting) || '—';
          return <Table.Cell key={suffix}><Text size="2" color="gray" title={`Locked: ${lockedRelays[relay]}`}>{text} 🔒</Text></Table.Cell>;
        }
        return (
          <Table.Cell key={suffix}>
            {setting ? <SettingInput settings={settings} setting={setting} invalid={clash.keys.has(setting.key) ? 'This digit is already used by another tone' : undefined} />
              : <Text color="gray">—</Text>}
          </Table.Cell>
        );
      })}
      {RELAY_BITS.map(([key]) => {
        const setting = byKey.get(key);
        if (!setting) return <Table.Cell key={key}><Text color="gray">—</Text></Table.Cell>;
        used.add(setting.key);
        const on = settings.current(setting)[relay] === '1';
        if (lockedRelays[relay]) {
          return <Table.Cell key={key}><Text size="2" color="gray" title={`Locked: ${lockedRelays[relay]}`}>{on ? 'On' : 'Off'} 🔒</Text></Table.Cell>;
        }
        const background = settings.current(setting)[relay] !== setting.value[relay] ? 'var(--blue-a4)' : setting.value[relay] !== setting.gate[relay] ? 'var(--green-a4)' : undefined;
        return (
          <Table.Cell key={key} style={{ background: background }}>
            <Box checked={on} onChange={(on) => settings.edit(setting, setBit(settings.current(setting), relay, on))} />
          </Table.Cell>
        );
      })}
    </Table.Row>
  )));
  const rest = fields.filter((setting) => !used.has(setting.key));
  return (
    <Flex direction="column" gap="3">
      {clash.lines.length > 0 && (
        <Callout.Root color="red" role="alert">
          <Callout.Text><strong>Each tone-open digit can be used only once.</strong> Change the red boxes before saving:</Callout.Text>
          <RadixBox asChild><ul style={{ margin: 0 }}>{clash.lines.map((line) => <li key={line}>{line}</li>)}</ul></RadixBox>
        </Callout.Root>
      )}
      <Table.Root size="1" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell rowSpan={2}>Relay</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell rowSpan={2}>Name<HelpTip of="relayName" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell rowSpan={2}>Strike time (s)<HelpTip of="strikeTime" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell colSpan={4}>Tone to open<HelpTip of="toneToOpen" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell colSpan={2}>Entry code range<HelpTip of="entryCodeRange" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell colSpan={2}>Activated by</Table.ColumnHeaderCell>
          </Table.Row>
          <Table.Row>
            {RELAY_COLS.slice(1).map(([k, label]) => <Table.ColumnHeaderCell key={k}>{label}</Table.ColumnHeaderCell>)}
            {RELAY_BITS.map(([k, label]) => (
              <Table.ColumnHeaderCell key={k}>{label}<HelpTip of={k === 'relayPostalSwitch' ? 'postalSwitch' : 'rotaryDial9'} /></Table.ColumnHeaderCell>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>{rows}</Table.Body>
      </Table.Root>
      {Object.entries(lockedRelays).map(([relay, note]) => <Text key={relay} size="1" color="gray">Relay {relay}: {note}</Text>)}
      {rest.length > 0 && <FieldGrid settings={settings} fields={rest} />}
    </Flex>
  );
}

interface GateSettingsEditorProps {
  settings: GateSettings;
  view: 'prefs' | 'relays' | 'display';
  displayMode?: 'single' | '8line';
  relayLabels?: Record<string, string | undefined>;
  lockedRelays?: Record<number, string>;
  relays?: number[];
  nameCell?: (relay: number) => ReactNode;
  gapi: GateApi;
  onReload: () => Promise<void> | void;
}

/**
 * The gate settings editor. prefs (System Settings): every group except Relays and Display; relays: the Relays
 * group; display: the Display group of the LCD layout chosen (single line or 8 line).
 * relays / nameCell: the Relays view's rows and name boxes (see RelayTable).
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.view - View.
 * @param [props.displayMode] - Display mode.
 * @param [props.relayLabels] - Relay labels.
 * @param [props.lockedRelays] - Locked relays.
 * @param [props.relays] - The Relays group.
 * @param props.nameCell - Name cell.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReload - Callback to reload the gate data.
 * @returns Rendered React element.
 */
export function GateSettingsEditor({ settings, view, displayMode = 'single', relayLabels = {}, lockedRelays = {}, relays = [0, 1, 2], nameCell,
  gapi, onReload }: GateSettingsEditorProps) {
  const shown = settings.fields.filter((setting) => !DEDICATED_GROUPS.has(setting.group));
  const groups = [...new Set(shown.map((setting) => setting.group))];
  const hiddenDisplay = displayMode === 'single' ? 'Display (8 line)' : 'Display (single line)';
  const wanted = groups.filter((group) => (view === 'display' ? group.startsWith('Display') && group !== hiddenDisplay
    : view === 'relays' ? group === 'Relays' : !group.startsWith('Display') && group !== 'Relays'));
  const clash = view === 'relays' ? toneClashes(settings, lockedRelays) : { keys: new Set<string>(), lines: [] };

  return (
    <Flex direction="column" gap="4">
      <SettingsBar settings={settings} gapi={gapi} onReload={onReload}
        blocked={clash.lines.length ? 'Two or more tones use the same digit; change the red boxes first' : undefined} />
      {view === 'display' ? wanted.map((group) => (
        <Flex key={group} direction="column" gap="2">
          <Heading size="3">{group}</Heading>
          <Table.Root size="1" variant="surface" style={{ width: 'fit-content', maxWidth: '100%' }}>
            <Table.Header>
              <Table.Row><Table.ColumnHeaderCell>Setting</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Value</Table.ColumnHeaderCell></Table.Row>
            </Table.Header>
            <Table.Body>
              {shown.filter((setting) => setting.group === group).map((setting) => (
                <Table.Row key={setting.key}>
                  <Table.Cell>{setting.name}</Table.Cell><Table.Cell><SettingInput settings={settings} setting={setting} /></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Flex>
      )) : wanted.map((group) => (
        <Flex key={group} direction="column" gap="2">
          {view === 'prefs' && <Heading size="3">{group}</Heading>}
          {group === 'Relays' ? <RelayTable settings={settings} fields={shown.filter((setting) => setting.group === group)} relayLabels={relayLabels} lockedRelays={lockedRelays}
            relays={relays} nameCell={nameCell} clash={clash} />
            : <FieldRows settings={settings} fields={shown.filter((setting) => setting.group === group)} />}
        </Flex>
      ))}
    </Flex>
  );
}
