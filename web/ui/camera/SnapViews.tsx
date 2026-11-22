import type { MouseEvent } from 'react';
import { Button, Dialog, Flex, IconButton, Progress, Text } from '@radix-ui/themes';
import type { TransactionRow } from '../../../src/types.ts';
import { useBackLayer } from '../back.ts';
import { fileChannel, frameCaption, isVideo, posterOf, shiftedTime, snapFiles, type Snaps } from './snapshots.ts';

interface SnapTileProps {
  transaction: TransactionRow;
  file: string;
  thumb: boolean;
  snaps: Snaps;
  onOpen?: () => void;
}

/**
 * One saved picture (or video), or a "?" box when it is missing, with a ↻ button that fetches it again.
 * thumb: the small Transactions-table version; clicking it opens the viewer.
 *
 * @param props - Component props.
 * @param props.transaction - Transaction record or row.
 * @param props.file - File path or filename.
 * @param props.thumb - The small Transactions-table version.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpen - On open.
 * @returns Rendered React element.
 */
function SnapTile({ transaction, file, thumb, snaps, onOpen }: SnapTileProps) {
  const snapshot = snaps.snapshots[transaction.minute];
  const key = `${transaction.minute}/${file}`;
  const video = isVideo(file);
  const saved = snapshot.files.includes(file);
  const label = `${snaps.channelName(fileChannel(file))} · ${frameCaption(file)}`;
  const partial = saved && snapshot.short ? snapshot.short[file] : 0;
  const shift = saved && snapshot.shifts ? snapshot.shifts[file] : 0;
  const title = `${label}${saved ? '' : ` · no ${video ? 'video' : 'picture'}${snapshot.error ? ` (${snapshot.error})` : ''}`}`
    + `${partial ? ` · partial video: ${partial} s of 2 minutes (click ↻ to get it again)` : ''}`
    + `${shift ? ` · taken at ${shiftedTime(transaction.minute, file, shift)} (${shift > 0 ? '+' : ''}${shift} s, no recording at the planned time)` : ''}`
    + `${thumb ? ` · click to see ${video ? 'the videos' : 'every frame'}` : ''}`;
  const open = thumb ? (event: MouseEvent) => { event.stopPropagation(); onOpen?.(); } : undefined;
  const busy = Boolean(snaps.refreshing[key]);
  const failed = snaps.errors[key];
  return (
    <span className={`snap-tile${thumb ? ' thumb' : ''}`}>
      {!saved ? <span className="snap-missing" title={title} onClick={open}>?</span>
        : video && !thumb ? <video className="snap-video" controls preload="none" title={title}
          poster={snaps.src(transaction.minute, file, posterOf(file))} src={snaps.src(transaction.minute, file)} />
          : <img className={thumb ? 'snap-thumb' : ''} src={snaps.src(transaction.minute, file, video ? posterOf(file) : file)} loading="lazy" alt={label}
            title={title} onClick={open} />}
      {video && thumb && saved && <span className="snap-play">▶</span>}
      {partial ? <span className="snap-partial">Partial</span> : null}
      <button type="button" className={`snap-refresh${busy ? ' busy' : ''}${failed ? ' failed' : ''}`} disabled={busy}
        title={busy ? `Getting this ${video ? 'video' : 'picture'} again…` : failed ? `Not refreshed: ${failed}. Click to try again.`
          : `Get ${label} again from the recorder`}
        onClick={(event) => { event.stopPropagation(); snaps.refresh(transaction.minute, file); }}>↻</button>
    </span>
  );
}

interface SnapBarProps {
  minute: string;
  snaps: Snaps;
}

/**
 * Progress for a transaction's minute while the snapshot run still has frames to fetch for it.
 *
 * @param props - Component props.
 * @param props.minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param props.snaps - Gate snapshot state and actions hook.
 * @returns Rendered React element.
 */
function SnapBar({ minute, snaps }: SnapBarProps) {
  const counts = snaps.byMinute[minute];
  const now = minute === snaps.current;
  return (
    <Flex display="inline-flex" align="center" gap="1" title={now ? `Downloading ${snaps.noun}: ${counts.done} of ${counts.frames}`
      : 'Waiting for its turn in the snapshot run'}>
      <Progress size="1" value={(counts.done / (counts.frames || 1)) * 100} style={{ width: 60 }} />
      <Text size="1" color="gray">{now ? `${counts.done} of ${counts.frames}` : 'Waiting'}</Text>
    </Flex>
  );
}

interface SnapCellProps {
  transaction: TransactionRow;
  snaps: Snaps;
  onOpen: (transaction: TransactionRow) => void;
}

/**
 * The Camera cell of a transaction: each channel's first saved frame, a progress bar while the run fetches its
 * minute, or a button that gets that minute's pictures (or video) only.
 *
 * @param props - Component props.
 * @param props.transaction - Transaction record or row.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpen - On open.
 * @returns Rendered React element.
 */
export function SnapCell({ transaction, snaps, onOpen }: SnapCellProps) {
  if (!transaction.camera) return <Text size="1" color="gray" title="Gate data transfers, hold-open events and other gate commands don't get camera footage">—</Text>;
  const snapshot = snaps.snapshots[transaction.minute];
  const bar = snaps.byMinute[transaction.minute] ? <SnapBar minute={transaction.minute} snaps={snaps} /> : null;
  const getButton = (title: string) => (
    <Button size="1" variant="soft" disabled={snaps.running} style={{ whiteSpace: 'nowrap' }}
      title={snaps.running ? 'Wait for the snapshot run to finish' : title}
      onClick={(event) => { event.stopPropagation(); snaps.runMinute(transaction.minute); }}>{snaps.video ? 'Get video' : 'Get pictures'}</Button>
  );
  if (snapshot && snapshot.status === 'removed') {
    return bar || (
      <Flex gap="2" align="center" wrap="nowrap">
        <Text size="1" color="gray" title={snapshot.error || ''}>Removed</Text>
        {getButton(`${snapshot.error ? `${snapshot.error}. ` : ''}Get the camera ${snaps.noun} again from the recorder (it works while the recorder still has this footage)`)}
      </Flex>
    );
  }
  if (!snapshot || (snaps.video && snapshot.files.length && !snapshot.files.some(isVideo))) return bar || getButton(`Get the camera ${snaps.noun} for this minute only`);
  const firsts = new Map<number, string>(); // channel -> its first saved frame, or its first frame when none is saved
  for (const file of snapFiles(snaps.settings, snapshot)) {
    const channel = fileChannel(file);
    if (!firsts.has(channel) || (!snapshot.files.includes(firsts.get(channel)!) && snapshot.files.includes(file))) firsts.set(channel, file);
  }
  return (
    <Flex gap="1" align="center" wrap="nowrap">
      {[...firsts.values()].map((file) => <SnapTile key={file} transaction={transaction} file={file} thumb snaps={snaps} onOpen={() => onOpen(transaction)} />)}
      {bar}
    </Flex>
  );
}

interface SnapViewerProps {
  transaction: TransactionRow | null;
  snaps: Snaps;
  onClose: () => void;
}

/**
 * Every frame (or video) of one transaction's minute, one row per channel.
 *
 * @param props - Component props.
 * @param props.transaction - Transaction record or row.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onClose - Callback invoked when the layer closes.
 * @returns Rendered React element.
 */
export function SnapViewer({ transaction, snaps, onClose }: SnapViewerProps) {
  const snapshot = transaction && snaps.snapshots[transaction.minute];
  const byChannel = new Map<number, string[]>();
  if (snapshot) for (const f of snapFiles(snaps.settings, snapshot)) byChannel.set(fileChannel(f), [...(byChannel.get(fileChannel(f)) || []), f]);
  useBackLayer(Boolean(transaction && snapshot), onClose);
  return (
    <Dialog.Root open={Boolean(transaction && snapshot)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Content width="fit-content" maxWidth="96vw" aria-describedby={undefined}>
        <Flex align="center" mb="3">
          <Dialog.Title mb="0">{transaction && `${transaction.date} ${transaction.time} · ${transaction.name || transaction.eventType || ''}`}</Dialog.Title>
          <Flex flexGrow="1" />
          <Dialog.Close><IconButton variant="ghost" color="gray" title="Close">✕</IconButton></Dialog.Close>
        </Flex>
        <Flex direction="column" gap="3" className="snap-viewer">
          {transaction && [...byChannel].sort((a, b) => a[0] - b[0]).map(([ch, files]) => (
            <Flex key={ch} gap="2" wrap="wrap" align="start" justify="center">
              {files.map((file) => (
                <figure key={file} className="snap-figure">
                  <SnapTile transaction={transaction} file={file} thumb={false} snaps={snaps} />
                  <figcaption>{snaps.channelName(ch)} · {frameCaption(file)}</figcaption>
                </figure>
              ))}
            </Flex>
          ))}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
