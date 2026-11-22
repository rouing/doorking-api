import { useState, type ReactNode } from 'react';
import { Button, Checkbox, Flex, Heading, Table, Text } from '@radix-ui/themes';
import type { GateSettingRow } from '../../../src/types.ts';
import { errorText } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import type { GateSettings } from './useGateSettings.ts';

export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const CLEAR_NOTE = 'Clear sets every setting on this page back to unset.'; // the gate stores relays 0-18; values for the others are kept unchanged

/**
 * How rowState judges a row: edited / pending override what the fields say (rows that also show relay columns);
 * pendingText is the status of a saved, unsent row.
 */
interface RowStateOptions { edited?: boolean; pending?: boolean; pendingText?: string }

/**
 * Row colour and status of a group of settings: blue = unsaved edit, green = saved but not sent to the gate.
 *
 * @param settings - Settings map or configuration.
 * @param fields - Field names or field updates.
 * @param [options] - Options object.
 * @param [options.edited] - Edited.
 * @param [options.pending] - Pending.
 * @param [options.pendingText] - Pending text.
 * @returns Operation result.
 */
export function rowState(settings: GateSettings, fields: (GateSettingRow | undefined)[], { edited, pending, pendingText = 'not sent' }: RowStateOptions = {}) {
  const list = fields.filter((field): field is GateSettingRow => Boolean(field));
  const isEdited = edited ?? list.some((setting) => setting.key in settings.edits);
  const isPending = !isEdited && (pending ?? list.some((setting) => setting.value !== setting.gate));
  return { style: { background: isEdited ? 'var(--blue-a4)' : isPending ? 'var(--green-a4)' : undefined }, status: isEdited ? 'unsaved' : isPending ? pendingText : '' };
}

interface BoxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  help?: string;
}

/**
 * A checkbox, with an optional label and "?" tip (help: a key in HELP).
 *
 * @param props - Component props.
 * @param props.checked - Checked.
 * @param props.onChange - Callback invoked when the value changes.
 * @param props.disabled - Whether the control is disabled.
 * @param props.label - Display label.
 * @param props.help - A key in HELP.
 * @returns Operation result.
 */
export function Box({ checked, onChange, disabled, label, help }: BoxProps) {
  const box = <Checkbox checked={checked} disabled={disabled} onCheckedChange={(checked) => onChange(checked === true)} />;
  return label ? <Text as="label" size="2"><Flex gap="1" align="center">{box}{label}{help && <HelpTip of={help} />}</Flex></Text> : box;
}

interface TimeBoxProps {
  value: string;
  onChange: (v: string) => void;
}

/**
 * The browser's own time input (sized to the time), styled like the other fields.
 *
 * @param props - Component props.
 * @param props.value - Input value.
 * @param props.onChange - Callback invoked when the value changes.
 * @returns Rendered React element.
 */
export function TimeBox({ value, onChange }: TimeBoxProps) {
  return <input type="time" className="time-input" value={value} onChange={(event) => onChange(event.target.value)} />;
}

/**
 * A string of '0'/'1' flags with position i set to on.
 *
 * @param bits - `string` value.
 * @param i - `number` value.
 * @param on - `boolean` value.
 * @returns Operation result.
 */
export const setBit = (bits: string, i: number, on: boolean) => {
  const flags = [...bits.padEnd(i + 1, '0')];
  flags[i] = on ? '1' : '0';
  return flags.join('');
};

interface GroupPageProps {
  title: string;
  intro: ReactNode;
  settings: GateSettings;
  group: string;
  buttons?: ReactNode;
  clearValue?: (setting: GateSettingRow) => string | undefined;
  help?: string;
  children: ReactNode;
}

/**
 * A page editing one group of gate settings in the working copy (Save / Discard, plus `buttons`), then `children`.
 * clearValue: adds a Clear button that sets each setting of the group to its unset value (undefined = leave it).
 * help: a key in HELP, shown as a "?" tip after the title.
 *
 * @param props - Component props.
 * @param props.title - Title.
 * @param props.intro - Intro.
 * @param props.settings - Settings map or configuration.
 * @param props.group - Group.
 * @param props.buttons - Buttons.
 * @param props.clearValue - Optional function returning each setting's cleared value (`undefined` leaves the field unchanged).
 * @param props.help - A key in HELP, shown as a "?" tip after the title.
 * @param props.children - Children.
 * @returns Rendered React element.
 */
export function GroupPage({ title, intro, settings, group, buttons, clearValue, help, children }: GroupPageProps) {
  const [saved, setSaved] = useState('');
  const fields = settings.fields.filter((setting) => setting.group === group);
  const unsaved = Object.keys(settings.edits).length;
  const pending = fields.filter((setting) => setting.value !== setting.gate).length;
  const save = async () => {
    try {
      const result = await settings.save();
      setSaved(`Saved to working copy. Changed block(s): ${result.changedBlocks.join(', ') || 'none'}`);
    } catch (err) { setSaved(`Save failed: ${errorText(err)}`); }
  };
  const info = !settings.reply ? settings.error : saved && !unsaved ? saved
    : [unsaved ? `${unsaved} unsaved change(s)` : 'No unsaved changes', pending ? `${pending} saved, not sent to the gate` : ''].filter(Boolean).join(' · ');
  return (
    <Flex direction="column" gap="3">
      <Heading>{title}{help && <HelpTip of={help} />}</Heading>
      <Text size="2" color="gray">{intro}</Text>
      <Flex gap="2" align="center" wrap="wrap">
        <Button onClick={save} disabled={!unsaved}>Save to working copy</Button>
        <Button variant="soft" color="gray" onClick={() => { settings.discard(); setSaved(''); }} disabled={!unsaved}>Discard unsaved</Button>
        {clearValue && (
          <Button variant="soft" color="gray" disabled={!fields.length} onClick={() => {
            for (const setting of fields) { const v = clearValue(setting); if (v !== undefined) settings.edit(setting, v); }
            setSaved('');
          }}>Clear</Button>
        )}
        {buttons}
        <Text size="2" color="gray">{info}</Text>
      </Flex>
      {settings.reply && fields.length > 0 && <Table.Root size="1" variant="surface" style={{ width: 'fit-content', maxWidth: '100%' }}>{children}</Table.Root>}
    </Flex>
  );
}

interface HeadProps {
  cols: string[];
}

/**
 * Header row of plain column labels.
 *
 * @param props - Component props.
 * @param props.cols - Table column definitions.
 * @returns Rendered React element.
 */
export function Head({ cols }: HeadProps) {
  return <Table.Header><Table.Row>{cols.map((column, i) => <Table.ColumnHeaderCell key={i}>{column}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header>;
}
