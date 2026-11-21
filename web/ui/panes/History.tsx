import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button, Card, Flex, Heading, Table, Text } from '@radix-ui/themes';
import type { HistoryEvent, HistoryReply } from '../../../src/types.ts';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';

export const ACTIONS: Record<string, string> = { change: 'Change', revert: 'Revert', pull: 'Pull', send: 'Send', relay: 'Relay', camera: 'Camera',
  access: 'Users', login: 'Gate login', apikey: 'API key', note: 'Note' };

// The gate's users with their last sign-in, then this gate's events (newest first). Rows with details expand on click, one at a
// time; Revert undoes that change in the working copy only.
export function History({ gapi, onReverted }: { gapi: GateApi; onReverted: () => void }) {
  const readOnly = useReadOnly();
  const [history, setHistory] = useState<HistoryReply | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [info, setInfo] = useState('Loading…');
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    setInfo('Loading…');
    try {
      const reply = await gapi<HistoryReply>('GET', '/history');
      setHistory(reply);
      setInfo(`${reply.events.length} events, most recent first`);
    } catch (err) { setInfo(errorText(err)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  async function revert(e: HistoryEvent) {
    if (!await confirm({ title: `Revert "${e.summary}"?`, action: 'Revert',
      body: 'This undoes the change in the working copy. The gate is not changed until you Send to gate.' })) return;
    try {
      await gapi('POST', `/history/${encodeURIComponent(e.id)}/revert`, {});
      await load();
      setInfo('Reverted in the working copy. Review it, then Send to gate.');
      onReverted();
    } catch (err) { setInfo(errorText(err)); }
  }

  return (
    <Flex direction="column" gap="3">
      {dialog}
      <Heading>History</Heading>
      <Text size="2" color="gray">
        Pulls, sends, live relay changes and working-copy changes for this gate. Click a change to see what changed.{' '}
        <strong>Revert</strong> undoes a change in the working copy only; review it, then use Send to gate. Revert is
        refused if a later change touched the same data.
      </Text>
      <Card>
        <Heading size="3" mb="2">Gate users</Heading>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row><Table.ColumnHeaderCell>User</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Role</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Last sign-in</Table.ColumnHeaderCell></Table.Row>
          </Table.Header>
          <Table.Body>
            {(history?.users || []).map((user) => (
              <Table.Row key={user.username}><Table.Cell>{user.username}</Table.Cell><Table.Cell>{user.role === 'admin' ? 'Admin' : 'Read only'}</Table.Cell>
                <Table.Cell>{user.lastSignIn ? fmtTime(user.lastSignIn) : 'never'}</Table.Cell></Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card>
      <Card>
        <Heading size="3" mb="2">Events</Heading>
        <Flex gap="3" align="center" mb="2">
          <Button variant="soft" color="gray" onClick={load}>Refresh</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>
              {['Time', 'User', 'Action', 'Summary', 'Result', ''].map((h, i) => <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>)}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(history?.events || []).map((e) => {
              const details = e.details || [];
              const result = e.result === 'failed' ? `Failed: ${e.error || ''}` : e.result === 'done' ? 'OK' : '';
              return (
                <Fragment key={e.id}>
                  <Table.Row onClick={details.length ? () => setOpen(open === e.id ? null : e.id) : undefined}
                    style={{ cursor: details.length ? 'pointer' : undefined, background: e.result === 'failed' ? 'var(--red-a3)' : undefined,
                      color: e.revertedBy ? 'var(--gray-10)' : undefined }}>
                    <Table.Cell style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.time)}</Table.Cell>
                    <Table.Cell>{e.user || ''}</Table.Cell>
                    <Table.Cell>{ACTIONS[e.action] || e.action}</Table.Cell>
                    <Table.Cell>{e.summary || ''}</Table.Cell>
                    <Table.Cell>{result}</Table.Cell>
                    <Table.Cell>
                      {e.revertedBy ? `Reverted by ${e.revertedBy.user} ${fmtTime(e.revertedBy.time)}`
                        : e.revertible && !readOnly ? <Button size="1" variant="soft" color="gray"
                          onClick={(event) => { event.stopPropagation(); revert(e); }}>Revert</Button> : ''}
                    </Table.Cell>
                  </Table.Row>
                  {open === e.id && details.length > 0 && (
                    <Table.Row>
                      <Table.Cell colSpan={6} style={{ background: 'var(--gray-a2)' }}>
                        <Flex direction="column" gap="2">
                          {details.map((detail) => (
                            <Flex key={detail.key + detail.label} direction="column" gap="1">
                              <Text size="2" weight="bold">{detail.label}{detail.change && detail.change !== 'changed' ? ` — ${detail.change}` : ''}</Text>
                              {detail.fields.length > 0 && (
                                <Table.Root size="1">
                                  <Table.Header>
                                    <Table.Row><Table.ColumnHeaderCell>Field</Table.ColumnHeaderCell><Table.ColumnHeaderCell>From</Table.ColumnHeaderCell>
                                      <Table.ColumnHeaderCell>To</Table.ColumnHeaderCell></Table.Row>
                                  </Table.Header>
                                  <Table.Body>
                                    {detail.fields.map((field, i) => (
                                      <Table.Row key={i}><Table.Cell>{field.field}</Table.Cell><Table.Cell>{field.from}</Table.Cell><Table.Cell>{field.to}</Table.Cell></Table.Row>
                                    ))}
                                  </Table.Body>
                                </Table.Root>
                              )}
                            </Flex>
                          ))}
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Fragment>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Card>
    </Flex>
  );
}
