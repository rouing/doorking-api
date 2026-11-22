import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Callout, Card, Checkbox, Flex, Heading, RadioGroup, Select, Text } from '@radix-ui/themes';
import type { GatePrefs, Relay, RelayTimer } from '../../../src/types.ts';
import { errorText, useIsAdmin, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { trackerOf, trackerRelays } from '../format.ts';
import { GateSettingsEditor } from './GateSettingsEditor.tsx';
import { RelayNameBox } from './LocalPrefs.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

interface Common {
  gapi: GateApi;
  onReload: () => Promise<void>;
}

interface LiveRelaysProps {
  gapi: GateApi;
  labels: Record<string, string>;
  relays: number[];
  commandRelays: number[];
}

/**
 * Live relay control: a button per relay (0-2, plus the Tracker relays when their box is ticked; green = held open,
 * red = released, grey = not checked). Refresh reads GetRelays when the page opens and on demand; tapping a button
 * toggles that relay (SetRelays) right away. commandRelays: Tracker command relays, greyed out (use their Tracker
 * relays instead).
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.labels - Labels.
 * @param props.relays - Relays.
 * @param props.commandRelays - Relay numbers acting as Tracker command relays (disabled in live control).
 * @returns Rendered React element.
 */
const HOLD_OPTIONS: [string, string][] = [
  ['15', 'Auto-release after 15 min'],
  ['30', 'Auto-release after 30 min'],
  ['60', 'Auto-release after 1 hour'],
  ['120', 'Auto-release after 2 hours'],
  ['240', 'Auto-release after 4 hours'],
  ['0', 'Hold until manually released'],
];

/** Formats remaining time until `releaseAt` as a concise countdown string. */
function countdownText(releaseAt: string, nowMs: number): string {
  const remaining = Math.max(0, new Date(releaseAt).getTime() - nowMs);
  const mins = Math.ceil(remaining / 60000);
  if (mins <= 0) return 'releasing soon';
  if (mins < 60) return `${mins}m left`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hours}h ${rem}m left` : `${hours}h left`;
}

function LiveRelays({ gapi, labels, relays, commandRelays }: LiveRelaysProps) {
  const isAdmin = useIsAdmin();
  const [state, setState] = useState<Record<number, string> | null>(null);
  const [timers, setTimers] = useState<RelayTimer[]>([]);
  const [holdMinutes, setHoldMinutes] = useState('30');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const codes = (list: Relay[]) => Object.fromEntries(Array.from({ length: 19 }, (_, i) => [i, list.find((relay) => relay.relay === i)?.code ?? '2']));

  useEffect(() => {
    if (!timers.length) return;
    const interval = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(interval);
  }, [timers.length]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setInfo('Asking the gate…');
    try {
      const reply = await gapi<{ checkedAt: string; relays: Relay[]; timers?: RelayTimer[] }>('GET', '/relays');
      setState(codes(reply.relays));
      setTimers(reply.timers || []);
      setNowMs(Date.now());
      setInfo(`Checked ${new Date(reply.checkedAt).toLocaleTimeString()}`);
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }, [gapi]);
  useEffect(() => { refresh(); }, [refresh]);

  async function toggle(i: number) {
    if (!state) return;
    const on = state[i] !== '1';
    const minutes = Number(holdMinutes);
    const bodyText = on
      ? (minutes > 0
        ? `This holds ${labels[i] || `Relay ${i}`} open immediately and automatically releases it in ${minutes} minutes.`
        : `This changes the gate immediately and holds it open until manually released.`)
      : 'This releases the relay immediately.';
    if (!await confirm({ title: `${on ? 'HOLD OPEN' : 'Release'} ${labels[i] || `Relay ${i}`} now?`, action: on ? 'Hold open' : 'Release', color: on ? 'red' : 'blue',
      body: bodyText })) return;
    setBusy(true);
    setInfo(on ? 'Holding open…' : 'Releasing…');
    try {
      const payload: Record<string, unknown> = { [i]: on, ...(on && minutes > 0 ? { holdMinutes: minutes } : {}) };
      const reply = await gapi<{ after: Relay[]; reply: string; timers?: RelayTimer[] }>('PUT', '/relays', payload);
      setState(codes(reply.after));
      setTimers(reply.timers || []);
      setNowMs(Date.now());
      setInfo(`Done (${reply.reply || 'ok'}) · ${new Date().toLocaleTimeString()}`);
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }

  async function cancelTimer(relayNum: number) {
    setBusy(true);
    try {
      const reply = await gapi<{ timers: RelayTimer[] }>('DELETE', `/relays/${relayNum}/timer`);
      setTimers(reply.timers || []);
      setInfo(`Auto-release timer cancelled on ${labels[relayNum] || `Relay ${relayNum}`}`);
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }

  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Live relay control<HelpTip of="liveRelays" /></Heading>
        <Text size="2" color="gray"><strong>Changes the gate immediately.</strong> Tap a relay to hold it open (green) or release it (red).
          Choose a hold duration to auto-release the gate automatically so it is never left open by mistake.</Text>
        <Flex gap="3" align="center" wrap="wrap">
          <Button variant="soft" color="gray" onClick={refresh} disabled={busy}>Refresh state</Button>
          <Select.Root size="2" value={holdMinutes} onValueChange={setHoldMinutes} disabled={busy}>
            <Select.Trigger />
            <Select.Content>
              {HOLD_OPTIONS.map(([val, label]) => <Select.Item key={val} value={val}>{label}</Select.Item>)}
            </Select.Content>
          </Select.Root>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
        {timers.length > 0 && (
          <Callout.Root color="amber">
            <Flex direction="column" gap="2">
              {timers.map((timer) => (
                <Flex key={timer.relay} align="center" gap="3" wrap="wrap">
                  <Text size="2">
                    <strong>{labels[timer.relay] || `Relay ${timer.relay}`}</strong> auto-releases at{' '}
                    {new Date(timer.releaseAt).toLocaleTimeString()} ({countdownText(timer.releaseAt, nowMs)})
                    {timer.lastError ? ` — retry failed: ${timer.lastError}` : ''}
                  </Text>
                  <Button size="1" variant="soft" color="gray" disabled={busy || !isAdmin} onClick={() => cancelTimer(timer.relay)}>Cancel timer</Button>
                </Flex>
              ))}
            </Flex>
          </Callout.Root>
        )}
        <Flex gap="3" wrap="wrap">
          {relays.map((i) => {
            const command = commandRelays.includes(i);
            const code = state && !command ? state[i] : null;
            const timer = timers.find((entry) => entry.relay === i);
            return (
              <Button key={i} size="4" color={code === '1' ? 'green' : code === '0' ? 'red' : 'gray'} disabled={busy || !isAdmin || code === null}
                variant={command ? 'soft' : undefined}
                title={!isAdmin ? 'Only a gate admin can control live relays' : command ? `Tracker command relay: it commands relays ${i === 1 ? '11-18' : '3-10'}, so it can't be held open here` : undefined}
                onClick={() => toggle(i)} style={{ minWidth: 180, height: 'auto', padding: '12px 16px', flexDirection: 'column', alignItems: 'flex-start' }}>
                <Flex align="center" gap="2">
                  <Text weight="bold">{labels[i] || `Relay ${i}`}</Text>
                  {timer && <Badge size="1" color="amber">{countdownText(timer.releaseAt, nowMs)}</Badge>}
                </Flex>
                <Text size="1">{command ? `Tracker command relay (relays ${i === 1 ? '11-18' : '3-10'})` : code === null ? 'tap Refresh to check'
                  : `${code === '1' ? 'HELD OPEN' : code === '0' ? 'Released' : 'Unknown — refresh'} — tap to ${code === '1' ? 'release' : 'hold open'}`}</Text>
              </Button>
            );
          })}
        </Flex>
        <Text size="2" color="gray">Relay names are set in the <strong>Relay settings</strong> table below.</Text>
      </Flex>
    </Card>
  );
}

/**
 * DoorKing32's note for a Tracker command relay (relay 1 commands Tracker 1, relays 11-18; relay 2 commands
 * Tracker 2, relays 3-10), plus the manual's (3.1.3): tones, postal switch and rotary dial 9 go on relay 0.
 *
 * @param range - `string` value.
 * @returns Computed result.
 */
const TRACKER_NOTE = (range: string) => `When Additional Relays Feature is selected, the relay time is 00 and cannot be changed. Times for Relays ${range} are set at the hardware. This relay is now a Tracker command relay, so its tone open numbers and entry code range are locked too; set them, and the postal switch and rotary dial 9, on relay 0.`;
const TRACKERS = [
  { key: 'tracker2', relay: 2, range: '3-10', label: 'Additional Relays For Tracker 2 (relays 3-10)' },
  { key: 'tracker1', relay: 1, range: '11-18', label: 'Additional Relays For Tracker 1 (relays 11-18)' },
] as const;

interface TrackerRelaysProps {
  prefs: GatePrefs;
  settings: GateSettings;
  gapi: GateApi;
  onReload: () => Promise<void>;
}

/**
 * The Additional Relays boxes (shown when Tracker is on in Gate configuration). Ticking one sets its command relay's
 * strike time to 00 in the working copy, as DoorKing32 does; the boxes themselves are saved for this page only
 * (DoorKing32 keeps them in ACCOUNT.DAT).
 *
 * @param props - Component props.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.settings - Settings map or configuration.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReload - Callback to reload the gate data.
 * @returns Rendered React element.
 */
function TrackerRelays({ prefs, settings, gapi, onReload }: TrackerRelaysProps) {
  const tracker = trackerOf(prefs);
  const [info, setInfo] = useState('');
  /**
   * Ticking remembers the strike time, then sets it to 00; unticking puts the remembered time back (as DoorKing32 does).
   *
   * @param key - Lookup key, API key, or setting key.
   * @param relay - `1 | 2` value.
   * @param on - `boolean` value.
   */
  async function toggle(key: 'tracker1' | 'tracker2', relay: 1 | 2, on: boolean) {
    setInfo('Saving…');
    const prevKey = `prevTime${relay}` as const;
    try {
      const time = settings.field(`relay${relay}Time`);
      const now = time ? settings.current(time) : '';
      const prev = on ? (now && now !== '0' ? now : prefs.tracker?.[prevKey]) : undefined;
      const want = on ? '0' : prefs.tracker?.[prevKey];
      if (time && want !== undefined && (want !== time.value || time.key in settings.edits)) {
        await gapi('PUT', '/settings', { [time.key]: want });
        settings.discard([time.key]);
        await settings.load();
      }
      await gapi('PUT', '/prefs', { tracker: { ...prefs.tracker, [key]: on, [prevKey]: prev } });
      setInfo(on ? `Saved. Relay ${relay} strike time is 00 in the working copy; Send to update the gate.`
        : want !== undefined ? `Saved. Relay ${relay} strike time is back to ${want} in the working copy; Send to update the gate.`
          : `Saved. Set relay ${relay}'s strike time below (its earlier time isn't known).`);
      await onReload();
    } catch (err) { setInfo(`Save failed: ${errorText(err)}`); }
  }
  return (
    <Card>
      <Flex direction="column" gap="2">
        <Heading size="3">Tracker expansion<HelpTip of="trackerExpansion" /></Heading>
        {TRACKERS.map((option) => (
          <Text key={option.key} as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={tracker[option.key]} onCheckedChange={(checked) => toggle(option.key, option.relay, checked === true)} />
            {option.label}, commanded by relay {option.relay}
          </Flex></Text>
        ))}
        <Text size="1" color="gray">Name the extra relays in the Relay settings table below. The boxes are saved for this page only.</Text>
        <Text size="2" color="gray">{info}</Text>
      </Flex>
    </Card>
  );
}

interface RelaysPageProps extends Common {
  prefs: GatePrefs;
}

/**
 * RelaysPage React component.
 *
 * @param props - Component props.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.common - Common.
 * @returns Rendered React element.
 */
export function RelaysPage({ prefs, ...common }: RelaysPageProps) {
  const settings = useGateSettings(common.gapi);
  const tracker = trackerOf(prefs);
  const relays = trackerRelays(tracker);
  const labels = Object.fromEntries(relays.map((i) => [i, (prefs.relayLabels && prefs.relayLabels[String(i)]) || `Relay ${i}`]));
  const lockedRelays = Object.fromEntries(TRACKERS.filter((option) => tracker[option.key]).map((option) => [option.relay, TRACKER_NOTE(option.range)]));
  return (
    <Flex direction="column" gap="4">
      <Heading>Relays</Heading>
      <LiveRelays gapi={common.gapi} labels={labels} relays={relays} commandRelays={Object.keys(lockedRelays).map(Number)} />
      {tracker.enabled && <TrackerRelays prefs={prefs} settings={settings} gapi={common.gapi} onReload={common.onReload} />}
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Relay settings</Heading>
          <GateSettingsEditor settings={settings} view="relays" relayLabels={labels} lockedRelays={lockedRelays} relays={relays}
            nameCell={(relay) => <RelayNameBox relay={relay} prefs={prefs} gapi={common.gapi} onSaved={common.onReload} />} {...common} />
        </Flex>
      </Card>
    </Flex>
  );
}

/**
 * Display: LCD message settings. The layout choice only picks which Display group is shown (the gate stores both;
 * the active mode is set in the DoorKing app). Remembered in this browser.
 *
 * @param common - `Common` value.
 * @returns Rendered React element.
 */
export function DisplayPage(common: Common) {
  const settings = useGateSettings(common.gapi);
  /** Stored as plain text (not JSON), so a saved choice from before the React page still reads back. */
  const [mode, setMode] = useState<'single' | '8line'>(() => {
    try { return localStorage.getItem('dk-display-mode') === '8line' ? '8line' : 'single'; } catch { return 'single'; }
  });
  const choose = (value: string) => {
    const displayMode = value === '8line' ? '8line' : 'single';
    setMode(displayMode);
    try { localStorage.setItem('dk-display-mode', displayMode); } catch { /* storage blocked */ }
  };
  return (
    <Flex direction="column" gap="4">
      <Heading>Display</Heading>
      <Card>
        <Flex direction="column" gap="2">
          <Flex gap="3" align="center" wrap="wrap">
            <Text size="2">LCD message layout:</Text>
            <RadioGroup.Root value={mode} onValueChange={choose}>
              <Flex gap="3"><RadioGroup.Item value="single">Single Line</RadioGroup.Item><RadioGroup.Item value="8line">8 Line</RadioGroup.Item></Flex>
            </RadioGroup.Root>
          </Flex>
          <Text size="2" color="gray">Which layout is shown below: Single Line (2 boxes) or 8 Line (8 boxes). Remembered in this browser; the gate
            stores both and the active mode is set in the DoorKing app.</Text>
        </Flex>
      </Card>
      <GateSettingsEditor settings={settings} view="display" displayMode={mode} {...common} />
    </Flex>
  );
}
