import { useMemo, useState } from 'react';
import { Button, Flex, Select, Table, Text, TextField } from '@radix-ui/themes';
import { usHolidaysForYear } from '../../../src/holidays.ts';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { Box, CLEAR_NOTE, GroupPage, Head, rowState } from './GroupPage.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

type Holiday = { name: string; month: number; day: number };
const NONE = '__none__';
const CUSTOM = '__custom__';

interface HolidayRowProps {
  settings: GateSettings;
  setting: GateSettingRow;
  index: number;
  holidays: Holiday[];
}

function HolidayRow({ settings, setting, index, holidays }: HolidayRowProps) {
  const [custom, setCustom] = useState(false);
  const v = settings.current(setting).trim();
  const name = (monthDay: string) => {
    const [month, day] = monthDay.split('/').map(Number);
    return holidays.find((holiday) => holiday.month === month && holiday.day === day)?.name || '';
  };
  const known = v !== '' && Boolean(name(v));
  const row = rowState(settings, [setting], { pendingText: 'saved, not sent' });
  return (
    <Table.Row style={row.style} title={`Gate (pulled): ${setting.gate || '(none)'}${setting.value !== setting.gate ? `\nWorking copy: ${setting.value || '(none)'}` : ''}`
      + `${setting.key in settings.edits ? `\nYour change: ${v || '(none)'}` : ''}`}>
      <Table.Cell>{index + 1}</Table.Cell>
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
        {v === '' ? '' : (name(v) || 'Custom') + (row.status === 'unsaved' ? ' · unsaved' : row.status ? ' · saved, not sent' : '')}
      </Text></Table.Cell>
    </Table.Row>
  );
}

export const HOL_FOR_SL = 'holidaysForSecurity';

interface HolidaysForSecurityProps {
  settings: GateSettings;
}

/**
 * The "Holidays for Security Levels" box. Turning it on asks first, as DoorKing32 does: TZ4 of every security
 * level becomes the Holiday time zone.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @returns Rendered React element.
 */
function HolidaysForSecurity({ settings }: HolidaysForSecurityProps) {
  const [dialog, confirm] = useConfirm();
  const field = settings.field(HOL_FOR_SL);
  if (!field) return null;
  const row = rowState(settings, [field], { pendingText: 'saved, not sent' });
  const toggle = async (on: boolean) => {
    if (on && !await confirm({ title: 'Enable Holidays for Security Levels?', action: 'Enable',
      body: 'Time zone 4 (TZ4) of every security level becomes the Holiday schedule (HOL), and it overrides the other time zones of the level on holidays. Nothing is sent to the gate until you Send.' })) return;
    settings.edit(field, on ? 'Yes' : 'No');
  };
  return (
    <Flex align="center" gap="2" px="2" style={{ ...row.style, borderRadius: 'var(--radius-2)' }}>
      {dialog}
      <Box checked={settings.current(field) === 'Yes'} onChange={toggle} label="Holidays for Security Levels (TZ4 becomes HOL)" help="holidaysForSecurity" />
      {row.status && <Text size="1" color="gray">{row.status}</Text>}
    </Flex>
  );
}

interface HolidaysPageProps {
  gapi: GateApi;
  holidays: Holiday[];
}

/**
 * Holidays: pick from the US holiday list (fixed + floating for the selected year) or enter a date.
 * The gate stores only month/day.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.holidays - Fallback fixed holiday list from the session.
 * @returns Rendered React element.
 */
export function HolidaysPage({ gapi }: HolidaysPageProps) {
  const settings = useGateSettings(gapi);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const yearHolidays = useMemo(() => usHolidaysForYear(year), [year]);
  const holidayFields = settings.fields.filter((setting) => setting.group === 'Holidays' && setting.key !== HOL_FOR_SL);
  const fillYear = () => {
    holidayFields.forEach((setting, index) => {
      const holiday = yearHolidays[index];
      settings.edit(setting, holiday ? `${holiday.month}/${holiday.day}` : '');
    });
  };
  return (
    <GroupPage settings={settings} group="Holidays" title="Holidays" help="holidays" clearValue={(setting) => (setting.key === HOL_FOR_SL ? undefined : '')}
      buttons={(
        <Flex align="center" gap="2" wrap="wrap">
          <Select.Root size="2" value={String(year)} onValueChange={(value) => setYear(Number(value))}>
            <Select.Trigger />
            <Select.Content>
              {[thisYear, thisYear + 1, thisYear + 2].map((optionYear) => (
                <Select.Item key={optionYear} value={String(optionYear)}>{optionYear}</Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Button variant="soft" onClick={fillYear} disabled={!holidayFields.length}>Fill {year} US holidays</Button>
          <HolidaysForSecurity settings={settings} />
        </Flex>
      )}
      intro={`Pick a holiday from the ${year} list (fixed and floating US holidays) or enter a date. ${CLEAR_NOTE} Clear leaves Holidays for Security Levels as it is. Edits go to the working copy (blue = unsaved, green = saved but not on the gate yet). The gate stores only month/day; names come from the built-in list.`}>
      <Head cols={['#', 'Holiday', 'Date (M/D)', 'Status']} />
      <Table.Body>
        {holidayFields.map((setting, index) => (
          <HolidayRow key={setting.key} settings={settings} setting={setting} index={index} holidays={yearHolidays} />
        ))}
      </Table.Body>
    </GroupPage>
  );
}

interface FacilityPageProps {
  gapi: GateApi;
}

/**
 * Facility Codes: the enable flag and up to 10 values (0-255; blank = unused).
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @returns Rendered React element.
 */
export function FacilityPage({ gapi }: FacilityPageProps) {
  const settings = useGateSettings(gapi);
  return (
    <GroupPage settings={settings} group="Facility Codes" title="Facility Codes" help="facility" clearValue={(setting) => (setting.key === 'facilityEnabled' ? 'No' : '')}
      intro={`Enable facility codes and set up to 10 values (000–255; blank = unused). For MicroPLUS transmitters, leave off the leading 0 of the 4-digit facility code (0124 → 124). ${CLEAR_NOTE} Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).`}>
      <Head cols={['Setting', 'Value', 'Status']} />
      <Table.Body>
        {settings.fields.filter((setting) => setting.group === 'Facility Codes').map((setting) => {
          const row = rowState(settings, [setting], { pendingText: 'saved, not sent' });
          return (
            <Table.Row key={setting.key} style={row.style}>
              <Table.Cell>{setting.name}</Table.Cell>
              <Table.Cell>
                {setting.key === 'facilityEnabled'
                  ? <Box checked={settings.current(setting) === 'Yes'} onChange={(on) => settings.edit(setting, on ? 'Yes' : 'No')} />
                  : <TextField.Root size="1" type="number" min={0} max={255} style={{ width: '10ch' }} value={settings.current(setting)}
                    onChange={(event) => settings.edit(setting, event.target.value.trim())} />}
              </Table.Cell>
              <Table.Cell><Text size="1" color="gray">{row.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
