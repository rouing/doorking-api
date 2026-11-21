import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Box, Button, Callout, Flex, Text, TextField } from '@radix-ui/themes';
import type { GateSettingRow, SendPreview } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { ConflictList } from '../panes/WorkingCopyBar.tsx';
import { gsShow, type GateSettings } from './useGateSettings.ts';

const HINTS: [string, string][] = [['holiday', 'MM/DD'], ['Tone', '1-9'], ['EntryCodeRange', '0000'], ['outsideLineDigit', '0-9']];

// Background of a setting: blue = unsaved edit, green = saved in the working copy but not sent to the gate.
export function settingTone(settings: GateSettings, setting: GateSettingRow) {
  return setting.key in settings.edits ? 'var(--blue-a4)' : setting.value !== setting.gate ? 'var(--green-a4)' : undefined;
}

export function settingTitle(settings: GateSettings, setting: GateSettingRow) {
  const edited = setting.key in settings.edits;
  const pending = setting.value !== setting.gate;
  return `${setting.name}\nGate (pulled): ${gsShow(setting.gate)}${pending ? `\nWorking copy (saved, not sent): ${gsShow(setting.value)}` : ''}`
    + `${edited ? `\nYour change (unsaved): ${gsShow(settings.edits[setting.key])}` : ''}`
    + `\nnames.bin offset 0x${setting.offset.toString(16)}${setting.editable ? '' : ' (read-only)'}`;
}

// Width in px that fits `max` of the widest character in the input's font as the browser draws it (its fonts, zoom and
// minimum font size included), plus the input's text indent and border and a little room for the caret; null until
// the input is on screen.
const SPARE_PX = 28; // room past a full-length message so it never touches the edge or scrolls

function useFitWidth(input: RefObject<HTMLInputElement | null>, max: number | null) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !max) return;
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.textContent = 'W'.repeat(max);
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontFamily: cs.fontFamily,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing: cs.letterSpacing });
    el.parentElement!.append(probe);
    const text = probe.getBoundingClientRect().width;
    probe.remove();
    const indent = parseFloat(cs.textIndent) || 0;
    const root = el.parentElement!.getBoundingClientRect().width - el.getBoundingClientRect().width;
    setWidth(Math.ceil(text + indent * 2 + root + SPARE_PX));
  }, [input, max]);
  return width;
}

// One input for a gate setting, coloured and with hover text as above. Text settings (display messages) are wide
// enough for the most characters the gate accepts (in a fixed-width font, like the gate's LCD) and stop at it.
// invalid: a reason the value can't be saved (red, and shown first in the hover text).
export function SettingInput({ gs: settings, s: setting, invalid }: { gs: GateSettings; s: GateSettingRow; invalid?: string }) {
  const max = setting.maxLength;
  const ref = useRef<HTMLInputElement>(null);
  const fit = useFitWidth(ref, max);
  const width = fit ? `${fit}px` : max ? `calc(${max}ch + var(--space-4))`
    : setting.editable ? '9ch' : `calc(${Math.max(9, settings.current(setting).length)}ch + var(--space-4))`;
  return (
    <TextField.Root ref={ref} size="1" value={settings.current(setting)} readOnly={!setting.editable}
      title={invalid ? `${invalid}\n${settingTitle(settings, setting)}` : settingTitle(settings, setting)} color={invalid ? 'red' : undefined}
      placeholder={HINTS.find(([k]) => setting.key.includes(k))?.[1] || ''} className={max ? 'lcd-input' : undefined}
      maxLength={max ?? undefined}
      style={{ width, minWidth: width, flexShrink: 0, background: invalid ? 'var(--red-a5)' : settingTone(settings, setting),
        opacity: setting.editable ? undefined : 0.7 }}
      onChange={(event) => settings.edit(setting, event.target.value)} />
  );
}

// Save / Discard / Reset to gate / Send to gate for the gate settings, the working-copy file links and the
// result of the last action. blocked: why the edits can't be saved yet (Save is disabled).
export function SettingsBar({ gs: settings, gapi, onReload, onJobStarted, blocked }: {
  gs: GateSettings; gapi: GateApi; onReload: () => Promise<void> | void; onJobStarted: () => void; blocked?: string;
}) {
  const [result, setResult] = useState<{ title: string; lines: string[] } | null>(null);
  const [dialog, confirm] = useConfirm();
  const n = Object.keys(settings.edits).length;
  const loaded = Boolean(settings.reply);

  const save = async () => {
    try {
      const r = await settings.save();
      setResult({ title: `Saved to the working copy. Block(s) differing from the gate: ${r.changedBlocks.join(', ') || 'none'}`,
        lines: r.changed.map((c) => `${c.name}: "${c.from}" → "${c.to}"`) });
      await onReload();
    } catch (err) { setResult({ title: 'Save failed', lines: [errorText(err)] }); }
  };

  const reset = async () => {
    if (!await confirm({ title: 'Reset to gate?', action: 'Reset', color: 'red',
      body: 'Throw away every change not sent to the gate (on every page), so the working copy matches what the gate holds?' })) return;
    try {
      await gapi('DELETE', '/working-copy');
      settings.discard();
      setResult({ title: 'Working copy reset to the gate', lines: [] });
      await settings.load();
      await onReload();
    } catch (err) { setResult({ title: 'Reset failed', lines: [errorText(err)] }); }
  };

  const send = async () => {
    let preview: SendPreview;
    try { preview = await gapi<SendPreview>('GET', '/send'); } catch (err) { setResult({ title: 'Send not possible', lines: [errorText(err)] }); return; }
    const blocks = Object.entries(preview.changedBlocks).filter(([, b]) => b.length);
    const lines: ReactNode[] = ['This changes the gate.', ...settings.changes, ...blocks.map(([f, b]) => `${f}: block(s) ${b.join(', ')}`),
      `Resident / vendor counts (from names.bin): ${preview.residentCounts.join(', ')}`, 'A residents pull runs afterwards to check the gate.'];
    if (!await confirm({ title: 'Send the working copy to the gate?', action: 'Send to gate',
      body: <Flex direction="column" gap="1">{lines.map((line, i) => <Text key={i}>{line}</Text>)}</Flex> })) return;
    try {
      await gapi('POST', '/send', { confirm: true });
      setResult({ title: 'Sending to the gate; progress is shown in the gate connection window', lines: [] });
      onJobStarted();
    } catch (err) { setResult({ title: 'Send failed', lines: [errorText(err)] }); }
  };

  const status = !loaded ? settings.error : [
    n ? `${n} unsaved change(s)` : 'No unsaved changes',
    settings.pending.length ? `${settings.pending.length} setting(s) saved, not sent (block(s) ${settings.blocks.join(', ')})` : '',
    `gate pulled ${new Date(settings.reply!.pulled).toLocaleString()}`,
    settings.pending.length ? `working copy saved ${new Date(settings.reply!.saved).toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <Flex direction="column" gap="2">
      {dialog}
      <Text size="2" color="gray">
        Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate). Hover a value to see the gate's value.
      </Text>
      <Flex gap="2" wrap="wrap" align="center">
        <Button onClick={save} disabled={!loaded || !n || Boolean(blocked)} title={blocked}>Save to working copy</Button>
        <Button variant="soft" color="gray" onClick={() => { settings.discard(); setResult(null); }} disabled={!loaded || !n}>Discard unsaved</Button>
        <Button variant="soft" color="gray" onClick={reset} disabled={!loaded || (!settings.pending.length && !settings.blocks.length)}>Reset to gate</Button>
        <Button variant="soft" onClick={send} disabled={!loaded || n > 0 || !settings.blocks.length || settings.conflicts.length > 0}
          title={n ? 'Save or discard unsaved changes first' : settings.conflicts.length ? 'Decide the conflicts first' : 'Send the working copy to the gate'}>
          Send to gate
        </Button>
      </Flex>
      <Text size="2" color="gray">{status}</Text>
      <ConflictList conflicts={settings.conflicts} gapi={gapi} onDecided={async () => { await settings.load(); await onReload(); }} />
      {result && (
        <Callout.Root color={result.title.includes('failed') || result.title.includes('not possible') ? 'red' : 'blue'}>
          <Callout.Text><strong>{result.title}</strong></Callout.Text>
          {result.lines.length > 0 && <Box asChild><ul style={{ margin: 0 }}>{result.lines.map((line, i) => <li key={i}>{line}</li>)}</ul></Box>}
        </Callout.Root>
      )}
    </Flex>
  );
}
