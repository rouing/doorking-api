import { useState } from 'react';
import { Badge, Box, Button, Callout, Flex, Table, Text } from '@radix-ui/themes';
import type { ConflictView, ResidentsReply, SendPreview } from '../../../src/types.ts';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';

interface ConflictListProps {
  conflicts: ConflictView[];
  gapi: GateApi;
  onDecided: () => Promise<void> | void;
}

/**
 * Items changed differently at the gate and in the working copy, each with Keep mine / Take the gate's (admins).
 * Sending waits until every one is decided.
 *
 * @param props - Component props.
 * @param props.conflicts - Conflicts.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onDecided - On decided.
 * @returns Rendered React element.
 */
export function ConflictList({ conflicts, gapi, onDecided }: ConflictListProps) {
  const readOnly = useReadOnly();
  const [error, setError] = useState('');
  if (!conflicts.length) return null;
  const decide = async (conflict: ConflictView, choice: 'mine' | 'gate') => {
    try { await gapi('POST', '/working-copy/conflicts', { kind: conflict.kind, key: conflict.key, choice }); setError(''); await onDecided(); } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Text>
        <strong>{conflicts.length} change{conflicts.length === 1 ? '' : 's'} to decide before sending.</strong> Since your last pull,
        these were changed at the gate and differently here. Your change is kept until you choose.
      </Callout.Text>
      <Flex direction="column" gap="2" mt="2">
        {conflicts.map((conflict) => (
          <Flex key={`${conflict.kind}-${conflict.key}`} gap="3" align="center" wrap="wrap">
            <Text size="2"><strong>{conflict.label}</strong>: at the gate {conflict.gate}; yours {conflict.mine}</Text>
            {!readOnly && <Button size="1" variant="soft" onClick={() => decide(conflict, 'mine')}>Keep mine</Button>}
            {!readOnly && <Button size="1" variant="soft" color="gray" onClick={() => decide(conflict, 'gate')}>Take the gate's</Button>}
          </Flex>
        ))}
        {error && <Text size="2" color="red">{error}</Text>}
      </Flex>
    </Callout.Root>
  );
}

/** The working copy's state: a label and colour for it, whether it has unsent changes, and its conflicts. */
export interface WorkingCopyState {
  edited: boolean;
  conflicts: ConflictView[];
  label: string;
  color: 'gray' | 'red' | 'amber' | 'green';
}

/**
 * Working copy state.
 *
 * @param cache - `ResidentsReply['cache'] | null` value.
 * @returns `WorkingCopyState` result.
 */
export function workingCopyState(cache: ResidentsReply['cache'] | null): WorkingCopyState {
  const edited = Boolean(cache && cache.edited);
  const conflicts = cache ? cache.conflicts : [];
  const [label, color] = !cache ? ['no working copy', 'gray'] as const
    : conflicts.length ? [`${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} to decide`, 'red'] as const
      : edited ? ['changes not sent to the gate', 'amber'] as const : ['matches the gate', 'green'] as const;
  return { edited, conflicts, label, color };
}

export interface WorkingCopyActionsOptions {
  gapi: GateApi;
  onReload: () => Promise<void> | void; // after a reset
  onJobStarted: () => void; // after a send started
  notify: (text: string) => void; // progress and success
  onError: (text: string) => void;
  sendLines?: string[]; // more lines for the send confirmation
}

/**
 * Reset to gate (drops the unsent changes) and Send to gate (then a residents pull checks the gate holds it), each
 * after a confirmation. Render `dialog` once.
 *
 * @param options - Options object.
 * @param options.gapi - Gate-scoped API fetch helper.
 * @param options.onReload - Callback to reload the gate data.
 * @param options.onJobStarted - On job started.
 * @param options.notify - Notify.
 * @param options.onError - On error.
 * @param [options.sendLines] - Send lines.
 * @returns Operation result.
 */
export function useWorkingCopyActions({ gapi, onReload, onJobStarted, notify, onError, sendLines = [] }: WorkingCopyActionsOptions) {
  const [dialog, confirm] = useConfirm();
  async function reset() {
    if (!await confirm({ title: 'Reset to gate?', action: 'Reset', color: 'red',
      body: 'Throw away every change not sent to the gate (on every page), so the working copy matches what the gate holds (as of the last pull)?' })) return;
    notify('Resetting…');
    try {
      await gapi('DELETE', '/working-copy');
      await onReload();
      notify('Working copy reset to the gate.');
    } catch (err) { onError(errorText(err)); }
  }
  async function send() {
    let preview: SendPreview;
    try { preview = await gapi<SendPreview>('GET', '/send'); } catch (err) { onError(errorText(err)); return; }
    if (!await confirm({ title: 'Send the working copy to the gate?', action: 'Send to gate', maxWidth: '680px', body: <SendSummary preview={preview} lines={sendLines} /> })) return;
    try {
      await gapi('POST', '/send', { confirm: true });
      notify('Sending to the gate; see the progress window.');
      onJobStarted();
    } catch (err) { onError(errorText(err)); }
  }
  return { dialog, reset, send };
}

export interface GateActionsOptions {
  gapi: GateApi;
  workingCopy: WorkingCopyState;
  hasWorkingCopy: boolean;
  running: boolean; // a gate connection is running
  onReset: () => Promise<void> | void;
  onJobStarted: () => void;
  onNotify: (text: string) => void; // progress, success and errors
}

const SEND_NOTE = 'Only changes saved to the working copy are sent; unsaved edits on a page stay there.';

/**
 * Send to gate and Reset to gate for the sidebar's gate connection and the phone's Gate sheet: the actions, and when
 * each is unavailable (canSend, canReset; sendHint says why Send can't run).
 *
 * @param options - Options object.
 * @param options.gapi - Gate-scoped API fetch helper.
 * @param options.workingCopy - Working copy.
 * @param options.hasWorkingCopy - Has working copy.
 * @param options.running - Running.
 * @param options.onReset - On reset.
 * @param options.onJobStarted - On job started.
 * @param options.onNotify - On notify.
 * @returns Operation result.
 */
export function useGateActions({ gapi, workingCopy, hasWorkingCopy, running, onReset, onJobStarted, onNotify }: GateActionsOptions) {
  const actions = useWorkingCopyActions({ gapi, onReload: onReset, onJobStarted, notify: onNotify, onError: onNotify, sendLines: [SEND_NOTE] });
  const conflicts = workingCopy.conflicts.length > 0;
  return {
    ...actions,
    canSend: !running && workingCopy.edited && !conflicts,
    canReset: !running && hasWorkingCopy,
    sendHint: conflicts ? 'Decide the conflicts first' : workingCopy.edited ? undefined : 'Nothing to send: the working copy matches the gate',
  };
}

interface SendSummaryProps { preview: SendPreview; lines: string[] }

/**
 * What a send changes, for its confirmation dialog: human-readable From -> To changes plus changed block summary.
 *
 * @param props - Component props.
 * @param props.preview - Preview returned by `GET /send`.
 * @param props.lines - Extra informational lines.
 * @returns Rendered React element.
 */
function SendSummary({ preview, lines }: SendSummaryProps) {
  const blocks = Object.entries(preview.changedBlocks).filter(([, changed]) => changed.length);
  const changes = preview.changes || [];
  return (
    <Flex direction="column" gap="2">
      <Text>This changes the physical gate.</Text>
      {lines.map((line) => <Text key={line} size="2" color="gray">{line}</Text>)}
      {changes.length > 0 && (
        <Box style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--gray-a5)', borderRadius: 'var(--radius-2)' }}>
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Item</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Field</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Gate</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>New</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {changes.flatMap((item) => (item.fields.length ? item.fields : [{ field: '', from: '', to: '' }]).map((field, index) => (
                <Table.Row key={`${item.key}-${field.field}-${index}`}>
                  <Table.Cell>
                    {index === 0 && (
                      <Flex align="center" gap="1" wrap="wrap">
                        <Text weight="medium">{item.label}</Text>
                        {item.change !== 'changed' && (
                          <Badge size="1" color={item.change === 'added' ? 'green' : 'red'}>{item.change}</Badge>
                        )}
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
      )}
      <Flex direction="column" gap="1">
        {blocks.map(([file, changed]) => <Text key={file} size="1" color="gray">{file}: block(s) {changed.join(', ')}</Text>)}
        <Text size="1" color="gray">Resident / vendor counts (from names.bin): {preview.residentCounts.join(', ')}</Text>
        <Text size="1" color="gray">A residents pull runs afterwards to verify the gate holds these changes.</Text>
      </Flex>
    </Flex>
  );
}

interface WorkingCopyBarProps {
  cache: ResidentsReply['cache'] | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
}

/**
 * The working copy's conflicts, on the Residents and Vendors pages. Its state, Reset to gate and Send to gate are in
 * the sidebar (phones: the top bar and the Gate tab, GateApp).
 *
 * @param props - Component props.
 * @param props.cache - Cache.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReload - Callback to reload the gate data.
 * @returns Rendered React element.
 */
export function WorkingCopyBar({ cache, gapi, onReload }: WorkingCopyBarProps) {
  return <ConflictList conflicts={workingCopyState(cache).conflicts} gapi={gapi} onDecided={onReload} />;
}
