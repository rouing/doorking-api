import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Checkbox, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { Schedule, ScheduleAction, SchedulesReply } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import { SCHEDULE_ACTIONS } from '../../../src/shared.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface SchedulesProps {
  gapi: GateApi;
  video: boolean;
}

// This gate's scheduled transfers (days 0-6 = Sun-Sat, 24-hour time), run by the server with the gate's DKS login.
export function Schedules({ gapi, video }: SchedulesProps) {
  const NAMES: Record<ScheduleAction, string> = { send: 'Send to gate', residents: 'Pull residents', transactions: 'Pull transactions',
    snapshots: video ? 'Camera videos' : 'Camera snapshots' };
  const LABELS: Record<ScheduleAction, string> = { send: 'Send working copy to gate', residents: 'Pull residents',
    transactions: 'Pull transactions', snapshots: video ? 'Get camera videos' : 'Get camera snapshots' };
  const [list, setList] = useState<SchedulesReply | null>(null);
  const [info, setInfo] = useState('Loading…');
  const [editing, setEditing] = useState<string | null>(null); // id in the form, or null when adding
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [time, setTime] = useState('02:00');
  const [actions, setActions] = useState<ScheduleAction[]>(['transactions']);
  const [enabled, setEnabled] = useState(true);
  const [formInfo, setFormInfo] = useState('');
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const reply = await gapi<SchedulesReply>('GET', '/schedules');
      setList(reply);
      setInfo(`${reply.schedules.length} schedule${reply.schedules.length === 1 ? '' : 's'}`);
    } catch (err) { setInfo(errorText(err)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  const fill = (schedule: Schedule | null) => {
    setEditing(schedule ? schedule.id : null);
    setDays(schedule ? schedule.days : [0, 1, 2, 3, 4, 5, 6]);
    setTime(schedule ? schedule.time : '02:00');
    setActions(schedule ? schedule.actions : ['transactions']);
    setEnabled(schedule ? schedule.enabled : true);
    setFormInfo('');
  };
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list.filter((other) => other !== item), item] : list.filter((other) => other !== item));

  async function save() {
    const body = { days: [...days].sort((a, b) => a - b), time, actions: SCHEDULE_ACTIONS.filter((action) => actions.includes(action)), enabled };
    if (body.actions.includes('send') && !await confirm({ title: 'Save this schedule?', action: 'Save',
      body: 'This schedule sends the working copy to the gate without asking.' })) return;
    setFormInfo('Saving…');
    try {
      await (editing ? gapi('PUT', `/schedules/${encodeURIComponent(editing)}`, body) : gapi('POST', '/schedules', body));
      fill(null);
      setFormInfo('Saved. It runs with the gate\'s DKS login.');
      await load();
    } catch (err) { setFormInfo(`Save failed: ${errorText(err)}`); }
  }

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (err) { setInfo(errorText(err)); } };
  const runNow = (schedule: Schedule) => act(async () => {
    await gapi('POST', `/schedules/${encodeURIComponent(schedule.id)}/run`, {});
    await load();
    setInfo('Queued. Progress shows under Gate connection.');
  });
  const remove = (schedule: Schedule) => act(async () => {
    if (!await confirm({ title: 'Delete this schedule?', action: 'Delete', color: 'red' })) return;
    await gapi('DELETE', `/schedules/${encodeURIComponent(schedule.id)}`);
    if (editing === schedule.id) fill(null);
    await load();
  });

  return (
    <Flex direction="column" gap="3">
      {dialog}
      <Heading>Scheduled Transfers</Heading>
      <Text size="2" color="gray">
        The server runs these at the set days and time (the server's local time), even when no one is signed in. They use the
        gate's DKS login (System Settings → Gate login). A time missed while the server was stopped runs once when it starts. Send to gate runs
        only when the working copy has changes, and runs before the pulls.
      </Text>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">{editing ? 'Edit schedule' : 'Add a schedule'}</Heading>
          <Flex gap="3" align="center" wrap="wrap">
            <Text size="2" weight="medium">Days:</Text>
            {DAYS.map((day, i) => (
              <Text key={day} as="label" size="2"><Flex gap="1" align="center">
                <Checkbox checked={days.includes(i)} onCheckedChange={(checked) => setDays(toggle(days, i, checked === true))} />{day}
              </Flex></Text>
            ))}
          </Flex>
          <Flex gap="3" align="center" wrap="wrap">
            <Text size="2" weight="medium">Time</Text>
            <TextField.Root type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            <Text size="2" weight="medium">Transfers:</Text>
            {SCHEDULE_ACTIONS.map((action) => (
              <Text key={action} as="label" size="2"><Flex gap="1" align="center">
                <Checkbox checked={actions.includes(action)} onCheckedChange={(checked) => setActions(toggle(actions, action, checked === true))} />{LABELS[action]}
              </Flex></Text>
            ))}
            <Text as="label" size="2"><Flex gap="1" align="center">
              <Checkbox checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} />Enabled
            </Flex></Text>
          </Flex>
          <Flex gap="3" align="center" wrap="wrap">
            <Button onClick={save}>Save schedule</Button>
            {editing && <Button variant="soft" color="gray" onClick={() => fill(null)}>Cancel edit</Button>}
            <Text size="2" color="gray">{formInfo}</Text>
          </Flex>
        </Flex>
      </Card>
      <Card>
        <Heading size="3" mb="2">Schedules for this gate</Heading>
        <Flex gap="3" align="center" wrap="wrap" mb="2">
          <Button variant="soft" color="gray" onClick={load}>Refresh</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>
              {['Days', 'Time', 'Transfers', 'Enabled', 'Saved by', 'Next run', 'Last run', 'Last result', ''].map((header, i) => (
                <Table.ColumnHeaderCell key={i}>{header}</Table.ColumnHeaderCell>))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(list?.schedules || []).map((schedule) => {
              const result = schedule.queued ? 'Queued' : schedule.lastResult === 'failed' ? `Failed: ${schedule.lastError || ''}`
                : schedule.lastResult === 'done' ? `OK${schedule.lastError ? ` — ${schedule.lastError}` : ''}` : '';
              return (
                <Table.Row key={schedule.id} style={{ background: schedule.lastResult === 'failed' && !schedule.queued ? 'var(--red-a3)' : undefined,
                  color: schedule.enabled ? undefined : 'var(--gray-10)' }}>
                  <Table.Cell>{schedule.days.length === 7 ? 'Every day' : schedule.days.map((day) => DAYS[day]).join(', ')}</Table.Cell>
                  <Table.Cell>{schedule.time}</Table.Cell>
                  <Table.Cell>{schedule.actions.map((action) => NAMES[action]).join(', ')}</Table.Cell>
                  <Table.Cell>{schedule.enabled ? 'Yes' : 'No'}</Table.Cell>
                  <Table.Cell>{schedule.user}</Table.Cell>
                  <Table.Cell>{fmtTime(schedule.nextRun)}</Table.Cell>
                  <Table.Cell>{fmtTime(schedule.lastRun)}</Table.Cell>
                  <Table.Cell>{result}</Table.Cell>
                  <Table.Cell><Flex gap="1">
                    <Button size="1" variant="soft" color="gray" onClick={() => fill(schedule)}>Edit</Button>
                    <Button size="1" variant="soft" color="gray" onClick={() => runNow(schedule)}>Run now</Button>
                    <Button size="1" variant="soft" color="red" onClick={() => remove(schedule)}>Delete</Button>
                  </Flex></Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Card>
    </Flex>
  );
}
