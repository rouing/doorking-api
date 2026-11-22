import { Fragment, useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Card, Dialog, Flex, Heading, IconButton, Table, Text } from '@radix-ui/themes';
import type { HistoryEvent, HistoryReply, PullArchiveEntry, SendChange } from '../../../src/types.ts';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import { roleLabel } from '../Gates.tsx';

export const ACTIONS: Record<string, string> = { change: 'Change', revert: 'Revert', pull: 'Pull', send: 'Send', relay: 'Relay', camera: 'Camera',
  access: 'Users', login: 'Gate login', apikey: 'API key', webhook: 'Webhook', note: 'Note' };

interface HistoryProps {
  gapi: GateApi;
  onReverted: () => void;
}

/**
 * The gate's users with their last sign-in, then this gate's events (newest first). Rows with details expand on click, one at a
 * time; Revert undoes that change in the working copy only.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReverted - On reverted.
 * @returns Rendered React element.
 */
export function History({ gapi, onReverted }: HistoryProps) {
  const readOnly = useReadOnly();
  const [history, setHistory] = useState<HistoryReply | null>(null);
  const [pulls, setPulls] = useState<PullArchiveEntry[]>([]);
  const [diffView, setDiffView] = useState<{ pull: PullArchiveEntry; changes: SendChange[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [info, setInfo] = useState('Loading…');
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    setInfo('Loading…');
    try {
      const [reply, archive] = await Promise.all([
        gapi<HistoryReply>('GET', '/history'),
        gapi<{ pulls: PullArchiveEntry[] }>('GET', '/pull-archive').catch(() => ({ pulls: [] })),
      ]);
      setHistory(reply);
      setPulls(archive.pulls);
      setInfo(`${reply.events.length} events, most recent first`);
    } catch (err) { setInfo(errorText(err)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  async function previewPull(pull: PullArchiveEntry) {
    try {
      const reply = await gapi<{ pull: PullArchiveEntry; changes: SendChange[] }>('GET', `/pull-archive/${pull.id}/diff`);
      setDiffView(reply);
    } catch (err) { setInfo(errorText(err)); }
  }

  async function restorePull(pull: PullArchiveEntry) {
    if (!await confirm({ title: `Restore pull from ${fmtTime(pull.pulledAt)}?`, action: 'Restore to working copy', color: 'red',
      body: 'This replaces the working copy with this archived pull. The physical gate is not changed until you Send to gate, and this restore can be reverted in History.' })) return;
    try {
      await gapi('POST', `/pull-archive/${pull.id}/restore`, {});
      setDiffView(null);
      await load();
      setInfo(`Restored pull #${pull.id} into the working copy. Review it, then Send to gate.`);
      onReverted();
    } catch (err) { setInfo(errorText(err)); }
  }

  async function revert(event: HistoryEvent) {
    if (!await confirm({ title: `Revert "${event.summary}"?`, action: 'Revert',
      body: 'This undoes the change in the working copy. The gate is not changed until you Send to gate.' })) return;
    try {
      await gapi('POST', `/history/${encodeURIComponent(event.id)}/revert`, {});
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
              <Table.Row key={user.username}><Table.Cell>{user.username}</Table.Cell><Table.Cell>{roleLabel(user.role)}</Table.Cell>
                <Table.Cell>{user.lastSignIn ? fmtTime(user.lastSignIn) : 'never'}</Table.Cell></Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Card>
      <Card>
        <Heading size="3" mb="2">Events</Heading>
        <Flex gap="3" align="center" wrap="wrap" mb="2">
          <Button variant="soft" color="gray" onClick={load}>Refresh</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>
              {['Time', 'User', 'Action', 'Summary', 'Result', ''].map((header, i) => <Table.ColumnHeaderCell key={i}>{header}</Table.ColumnHeaderCell>)}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(history?.events || []).map((entry) => {
              const details = entry.details || [];
              const result = entry.result === 'failed' ? `Failed: ${entry.error || ''}` : entry.result === 'done' ? 'OK' : '';
              return (
                <Fragment key={entry.id}>
                  <Table.Row onClick={details.length ? () => setOpen(open === entry.id ? null : entry.id) : undefined}
                    style={{ cursor: details.length ? 'pointer' : undefined, background: entry.result === 'failed' ? 'var(--red-a3)' : undefined,
                      color: entry.revertedBy ? 'var(--gray-10)' : undefined }}>
                    <Table.Cell style={{ whiteSpace: 'nowrap' }}>{fmtTime(entry.time)}</Table.Cell>
                    <Table.Cell>{entry.user || ''}</Table.Cell>
                    <Table.Cell>{ACTIONS[entry.action] || entry.action}</Table.Cell>
                    <Table.Cell>{entry.summary || ''}</Table.Cell>
                    <Table.Cell>{result}</Table.Cell>
                    <Table.Cell>
                      {entry.revertedBy ? `Reverted by ${entry.revertedBy.user} ${fmtTime(entry.revertedBy.time)}`
                        : entry.revertible && !readOnly ? <Button size="1" variant="soft" color="gray"
                          onClick={(event) => { event.stopPropagation(); revert(entry); }}>Revert</Button> : ''}
                    </Table.Cell>
                  </Table.Row>
                  {open === entry.id && details.length > 0 && (
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
      {pulls.length > 0 && (
        <Card>
          <Heading size="3" mb="2">Past pulls (point-in-time rollback)</Heading>
          <Text size="2" color="gray" as="p" mb="2">
            Up to 50 distinct residents pulls are archived per gate. Compare any past pull against your current working
            copy, or restore it to the working copy (nothing touches the gate until Send to gate).
          </Text>
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Pulled</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>By</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Entries</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Cards</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {pulls.map((pull) => (
                <Table.Row key={pull.id}>
                  <Table.Cell style={{ whiteSpace: 'nowrap' }}>{fmtTime(pull.pulledAt)}</Table.Cell>
                  <Table.Cell>{pull.actor}</Table.Cell>
                  <Table.Cell>{pull.residentsCount}</Table.Cell>
                  <Table.Cell>{pull.cardsCount}</Table.Cell>
                  <Table.Cell>
                    <Flex gap="2">
                      <Button size="1" variant="soft" color="gray" onClick={() => previewPull(pull)}>Compare</Button>
                      {!readOnly && <Button size="1" variant="soft" onClick={() => restorePull(pull)}>Restore</Button>}
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Card>
      )}
      <Dialog.Root open={diffView !== null} onOpenChange={(isOpen) => { if (!isOpen) setDiffView(null); }}>
        <Dialog.Content maxWidth="720px" aria-describedby={undefined}>
          <Flex align="center" mb="3">
            <Dialog.Title mb="0">
              {diffView ? `Changes to restore pull from ${fmtTime(diffView.pull.pulledAt)}` : ''}
            </Dialog.Title>
            <Flex flexGrow="1" />
            <Dialog.Close><IconButton variant="ghost" color="gray" title="Close">✕</IconButton></Dialog.Close>
          </Flex>
          {diffView && (diffView.changes.length === 0 ? (
            <Text size="2" color="gray">The working copy already matches this pull.</Text>
          ) : (
            <Box style={{ maxHeight: 380, overflowY: 'auto' }}>
              <Table.Root size="1">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Item</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Field</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Current</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Archived</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {diffView.changes.flatMap((item) => (item.fields.length ? item.fields : [{ field: '', from: '', to: '' }]).map((field, index) => (
                    <Table.Row key={`${item.key}-${field.field}-${index}`}>
                      <Table.Cell>
                        {index === 0 && (
                          <Flex align="center" gap="1" wrap="wrap">
                            <Text weight="medium">{item.label}</Text>
                            {item.change !== 'changed' && <Badge size="1" color={item.change === 'added' ? 'green' : 'red'}>{item.change}</Badge>}
                          </Flex>
                        )}
                      </Table.Cell>
                      <Table.Cell>{field.field}</Table.Cell>
                      <Table.Cell><Text color="gray">{field.from || '—'}</Text></Table.Cell>
                      <Table.Cell>{field.to || '—'}</Table.Cell>
                    </Table.Row>
                  )))}
                </Table.Body>
              </Table.Root>
            </Box>
          ))}
          {diffView && !readOnly && diffView.changes.length > 0 && (
            <Flex justify="end" gap="2" mt="3">
              <Button color="red" onClick={() => restorePull(diffView.pull)}>Restore to working copy</Button>
            </Flex>
          )}
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}
