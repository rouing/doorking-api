import { useState } from 'react';
import { Flex, Select, Table, Text, TextField } from '@radix-ui/themes';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { Box, CLEAR_NOTE, GroupPage, Head, rowState } from './GroupPage.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

type Holiday = { name: string; month: number; day: number };
const NONE = '__none__';
const CUSTOM = '__custom__';

function HolidayRow({ gs: settings, f: setting, i, holidays }: { gs: GateSettings; f: GateSettingRow; i: number; holidays: Holiday[] }) {
  const [custom, setCustom] = useState(false);
  const v = settings.current(setting).trim();
  const name = (md: string) => {
    const [m, d] = md.split('/').map(Number);
    return holidays.find((holiday) => holiday.month === m && holiday.day === d)?.name || '';
  };
  const known = v !== '' && Boolean(name(v));
  const st = rowState(settings, [setting], undefined, undefined, 'saved, not sent');
  return (
    <Table.Row style={st.style} title={`Gate (pulled): ${setting.gate || '(none)'}${setting.value !== setting.gate ? `\nWorking copy: ${setting.value || '(none)'}` : ''}`
      + `${setting.key in settings.edits ? `\nYour change: ${v || '(none)'}` : ''}`}>
      <Table.Cell>{i + 1}</Table.Cell>
      <Table.Cell>
        <Select.Root size="1" value={custom || (v !== '' && !known) ? CUSTOM : v === '' ? NONE : v}
          onValueChange={(sel) => {
            if (sel === CUSTOM) { setCustom(true); return; }
            setCustom(false);
            settings.edit(setting, sel === NONE ? '' : sel);
          }}>
          <Select.Trigger style={{ minWidth: '16ch' }} />
          <Select.Content>
            <Select.Item value={NONE}>— none —</Select.Item>
            {holidays.map((holiday) => <Select.Item key={holiday.name} value={`${holiday.month}/${holiday.day}`}>{holiday.name}</Select.Item>)}
            <Select.Item value={CUSTOM}>Custom date…</Select.Item>
          </Select.Content>
        </Select.Root>
      </Table.Cell>
      <Table.Cell><TextField.Root size="1" placeholder="M/D" style={{ width: '8ch' }} value={settings.current(setting)}
        onChange={(event) => { setCustom(false); settings.edit(setting, event.target.value.trim()); }} /></Table.Cell>
      <Table.Cell><Text size="1" color="gray">
        {v === '' ? '' : (name(v) || 'Custom') + (st.status === 'unsaved' ? ' · unsaved' : st.status ? ' · saved, not sent' : '')}
      </Text></Table.Cell>
    </Table.Row>
  );
}

export const HOL_FOR_SL = 'holidaysForSecurity';

// The "Holidays for Security Levels" box. Turning it on asks first, as DoorKing32 does: TZ4 of every security
// level becomes the Holiday time zone.
function HolidaysForSecurity({ gs: settings }: { gs: GateSettings }) {
  const [dialog, confirm] = useConfirm();
  const f = settings.field(HOL_FOR_SL);
  if (!f) return null;
  const st = rowState(settings, [f], undefined, undefined, 'saved, not sent');
  const toggle = async (on: boolean) => {
    if (on && !await confirm({ title: 'Enable Holidays for Security Levels?', action: 'Enable',
      body: 'Time zone 4 (TZ4) of every security level becomes the Holiday schedule (HOL), and it overrides the other time zones of the level on holidays. Nothing is sent to the gate until you Send.' })) return;
    settings.edit(f, on ? 'Yes' : 'No');
  };
  return (
    <Flex align="center" gap="2" px="2" style={{ ...st.style, borderRadius: 'var(--radius-2)' }}>
      {dialog}
      <Box checked={settings.current(f) === 'Yes'} onChange={toggle} label="Holidays for Security Levels (TZ4 becomes HOL)" help="holidaysForSecurity" />
      {st.status && <Text size="1" color="gray">{st.status}</Text>}
    </Flex>
  );
}

// Holidays: pick from the fixed-date list or enter a date. The gate stores only month/day.
export function HolidaysPage({ gapi, holidays }: { gapi: GateApi; holidays: Holiday[] }) {
  const settings = useGateSettings(gapi);
  return (
    <GroupPage gs={settings} group="Holidays" title="Holidays" help="holidays" clearValue={(setting) => (setting.key === HOL_FOR_SL ? undefined : '')}
      buttons={<HolidaysForSecurity gs={settings} />}
      intro={`Pick a holiday from the list or enter a date. ${CLEAR_NOTE} Clear leaves Holidays for Security Levels as it is. Edits go to the working copy (blue = unsaved, green = saved but not on the gate yet). The gate stores only month/day; names come from the built-in list.`}>
      <Head cols={['#', 'Holiday', 'Date (M/D)', 'Status']} />
      <Table.Body>
        {settings.fields.filter((setting) => setting.group === 'Holidays' && setting.key !== HOL_FOR_SL)
          .map((setting, i) => <HolidayRow key={setting.key} gs={settings} f={setting} i={i} holidays={holidays} />)}
      </Table.Body>
    </GroupPage>
  );
}

// Facility Codes: the enable flag and up to 10 values (0-255; blank = unused).
export function FacilityPage({ gapi }: { gapi: GateApi }) {
  const settings = useGateSettings(gapi);
  return (
    <GroupPage gs={settings} group="Facility Codes" title="Facility Codes" help="facility" clearValue={(setting) => (setting.key === 'facilityEnabled' ? 'No' : '')}
      intro={`Enable facility codes and set up to 10 values (000–255; blank = unused). For MicroPLUS transmitters, leave off the leading 0 of the 4-digit facility code (0124 → 124). ${CLEAR_NOTE} Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).`}>
      <Head cols={['Setting', 'Value', 'Status']} />
      <Table.Body>
        {settings.fields.filter((setting) => setting.group === 'Facility Codes').map((setting) => {
          const st = rowState(settings, [setting], undefined, undefined, 'saved, not sent');
          return (
            <Table.Row key={setting.key} style={st.style}>
              <Table.Cell>{setting.name}</Table.Cell>
              <Table.Cell>
                {setting.key === 'facilityEnabled'
                  ? <Box checked={settings.current(setting) === 'Yes'} onChange={(on) => settings.edit(setting, on ? 'Yes' : 'No')} />
                  : <TextField.Root size="1" type="number" min={0} max={255} style={{ width: '10ch' }} value={settings.current(setting)}
                    onChange={(event) => settings.edit(setting, event.target.value.trim())} />}
              </Table.Cell>
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
