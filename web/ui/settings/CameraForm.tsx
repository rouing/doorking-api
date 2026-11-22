import { useState } from 'react';
import { Button, Card, Checkbox, Flex, Grid, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { CameraSettings } from '../../../src/types.ts';
import { errorText, gateUrl, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { Choice, Field } from '../panes/fields.tsx';

type LiveFrame = { channel: number; name?: string; file?: string; error?: string };

const nums = (list: number[]): string[] => list.map(String);

interface CameraFormProps {
  settings: CameraSettings | null;
  phone: string;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

// Gate cameras: a Dahua/Amcrest recorder reached through Dahua's P2P cloud. Up to 4 channels. The password is
// never sent back; leaving it blank keeps the saved one.
export function CameraForm({ settings, phone, gapi, onSaved }: CameraFormProps) {
  const saved = settings;
  const [form, setForm] = useState(() => ({
    serial: saved?.serial || '', username: saved?.username || '', password: '', clockOffset: String(saved?.clockOffset ?? 0), mode: saved?.mode || 'snapshots',
    frames: String(saved?.frames ?? 3), framesAfter: String(saved?.framesAfter ?? 0), clipTries: String(saved?.clipTries ?? 2), events: saved?.events || 'access',
    backfillHours: String(saved?.backfillHours ?? 24), keepDays: String(saved?.keepDays ?? 0), enabled: saved ? saved.enabled !== false : true,
  }));
  // Four rows, or as many as are saved (up to 8 through the API), so saving keeps every channel.
  const [channels, setChannels] = useState(() => Array.from({ length: Math.max(4, saved?.channels?.length || 0) }, (_, i) => {
    const channel = (saved?.channels || [{ channel: 1, name: '' }])[i];
    return { channel: channel ? String(channel.channel) : '', name: channel ? channel.name : '' };
  }));
  const [info, setInfo] = useState('');
  const [live, setLive] = useState<{ frames: LiveFrame[]; stamp: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [dialog, confirm] = useConfirm();
  const set = (key: keyof typeof form, value: string | boolean) => setForm({ ...form, [key]: value });
  const video = form.mode === 'video';

  const run = async (fn: () => Promise<void>) => { try { await fn(); } catch (err) { setInfo(errorText(err)); } };
  const save = () => run(async () => {
    const keep = Number(form.keepDays);
    if (keep && keep !== (settings?.keepDays || 0) && !await confirm({ title: `Keep pictures for ${keep} days?`, action: 'Save', color: 'red',
      body: `Pictures and videos older than ${keep} days are deleted now, and each day from then on. This cannot be undone.` })) return;
    setInfo('Saving…');
    try { await gapi('PUT', '/cameras', { ...form, channels: channels.map((channel) => ({ channel: channel.channel.trim(), name: channel.name })) }); } catch (err) {
      setInfo(`Save failed: ${errorText(err)}`); return;
    }
    set('password', '');
    setInfo('Saved. Use Test to check the login and channels.');
    await onSaved();
  });
  const test = () => run(async () => {
    setInfo('Connecting to the recorder… (up to a minute)');
    setTesting(true);
    try {
      const reply = await gapi<{ channels: LiveFrame[] }>('POST', '/cameras/test', {});
      setLive({ frames: reply.channels, stamp: Date.now() });
      setInfo(`Live pictures from ${reply.channels.filter((channel) => channel.file).length} of ${reply.channels.length} channels.`);
    } catch (err) { setInfo(`Test failed: ${errorText(err)}`); }
    setTesting(false);
  });
  const remove = () => run(async () => {
    if (!await confirm({ title: 'Remove the camera settings for this gate?', body: 'Saved snapshots are kept.', action: 'Remove', color: 'red' })) return;
    await gapi('DELETE', '/cameras');
    setLive(null);
    setInfo('Removed.');
    await onSaved();
  });
  const deleteSnaps = () => run(async () => {
    if (!await confirm({ title: 'Delete all saved camera pictures for this gate?', action: 'Delete all', color: 'red',
      body: 'This cannot be undone. Transactions still in the look-back period get new pictures on the next snapshot run.' })) return;
    try {
      const reply = await gapi<{ files: number; minutes: number }>('DELETE', '/snapshots');
      setLive(null);
      setInfo(`Deleted ${reply.files} pictures (${reply.minutes} minutes).`);
      await onSaved();
    } catch (err) { setInfo(`Delete failed: ${errorText(err)}`); }
  });

  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Gate cameras</Heading>
        <Text size="2" color="gray">
          A Dahua/Amcrest recorder reached through Dahua's P2P cloud (as DMSS/SmartPSS do). After each transactions pull, including
          scheduled pulls, frames (or a 2-minute video) from each channel for every new transaction's minute are saved and shown on the
          Transactions page. Stored locally and <strong>shared by every account that manages this gate</strong>; the password is
          encrypted in the local database.
        </Text>
        <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
          <Field label="Recorder serial" help="cameraSerial"><TextField.Root autoComplete="off" value={form.serial} onChange={(event) => set('serial', event.target.value)} /></Field>
          <Field label="Username"><TextField.Root autoComplete="off" value={form.username} onChange={(event) => set('username', event.target.value)} /></Field>
          <Field label="Password"><TextField.Root type="password" autoComplete="new-password" value={form.password}
            placeholder={settings ? 'saved (leave blank to keep)' : ''} onChange={(event) => set('password', event.target.value)} /></Field>
          <Field label="Clock offset (seconds)" help="clockOffset"><TextField.Root type="number" step="1" value={form.clockOffset} onChange={(event) => set('clockOffset', event.target.value)} /></Field>
          <Field label="Save" help="cameraMode"><Choice value={form.mode} onChange={(value) => set('mode', value)} options={[['snapshots', 'Snapshots (pictures)'], ['video', '2-minute video clips']]} /></Field>
          <Field label="Frames per transaction" help="cameraFrames"><Choice value={form.frames} onChange={(value) => set('frames', value)} options={nums([1, 2, 3, 4, 6])} disabled={video} /></Field>
          <Field label="Frames after the minute" help="cameraFramesAfter"><Choice value={form.framesAfter} onChange={(value) => set('framesAfter', value)} options={nums([0, 1, 2, 3, 4, 6])} disabled={video} /></Field>
          <Field label="Video tries"><Choice value={form.clipTries} onChange={(value) => set('clipTries', value)} options={nums([1, 2, 3, 4, 5])} disabled={!video} /></Field>
          <Field label="Transactions" help="cameraEvents"><Choice value={form.events} onChange={(value) => set('events', value)} options={[['access', 'Admitted and denied entries'], ['all', 'All']]} /></Field>
          <Field label="Keep pictures" help="cameraKeep"><Choice value={form.keepDays} onChange={(value) => set('keepDays', value)}
            options={[['15', '15 days'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days'], ['0', 'Forever']]} /></Field>
          <Field label="Look back (hours)" help="cameraLookBack"><TextField.Root type="number" min={0} max={720} step="1" value={form.backfillHours} onChange={(event) => set('backfillHours', event.target.value)} /></Field>
        </Grid>
        <Table.Root size="1" style={{ width: 'fit-content' }}>
          <Table.Header><Table.Row><Table.ColumnHeaderCell>Channel</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell></Table.Row></Table.Header>
          <Table.Body>
            {channels.map((channel, i) => (
              <Table.Row key={i}>
                <Table.Cell><TextField.Root size="1" inputMode="numeric" style={{ width: '6ch' }} value={channel.channel}
                  onChange={(event) => setChannels(channels.map((entry, j) => (j === i ? { ...entry, channel: event.target.value } : entry)))} /></Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={40} value={channel.name}
                  onChange={(event) => setChannels(channels.map((entry, j) => (j === i ? { ...entry, name: event.target.value } : entry)))} /></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        <Text as="label" size="2"><Flex gap="2" align="center">
          <Checkbox checked={form.enabled} onCheckedChange={(checked) => set('enabled', checked === true)} /> Save snapshots after transaction pulls
        </Flex></Text>
        <Text size="2" color="gray">
          Clock offset is added to the gate's transaction time to match the recorder's clock. Look back limits which transactions get
          snapshots (recorders keep only so many days). Leave the password blank to keep the saved one.
        </Text>
        {video && (
          <Text size="2" color="gray">
            Videos run from the start of the transaction's minute for 2 minutes, at the recorder's full quality without re-encoding (about
            65 MB per channel for a 4 Mbit/s camera). The recorder sends them at normal playback speed, so each video takes about 2 minutes
            to fetch, one at a time. H.265 cameras need a browser that plays H.265 (current Safari, and Chrome or Edge on most computers
            with hardware support).
          </Text>
        )}
        <Flex gap="2" wrap="wrap" align="center">
          <Button onClick={save}>Save camera settings</Button>
          <Button variant="soft" onClick={test} disabled={!settings || testing}>Test (live picture)</Button>
          <Button variant="soft" color="gray" onClick={remove} disabled={!settings}>Remove</Button>
          <Button variant="soft" color="red" onClick={deleteSnaps}>Delete all pictures</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
        {live && (
          <Flex gap="2" wrap="wrap" align="start">
            {live.frames.map((frame) => (frame.file ? (
              <figure key={frame.channel} className="snap-figure">
                <img src={`${gateUrl(phone, `/snapshots/live/${frame.file}`)}?t=${live.stamp}`} alt={frame.name || `Channel ${frame.channel}`} style={{ maxWidth: 320 }} />
                <figcaption>{frame.name || `Channel ${frame.channel}`} (channel {frame.channel})</figcaption>
              </figure>
            ) : <Text key={frame.channel} size="2" color="red">Channel {frame.channel}: {frame.error}</Text>))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
