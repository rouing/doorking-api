/**
 * @module src/snapshot-files
 *
 * Snapshot file names shared by the server (camera-log.ts, cameras.ts) and the page (web/ui/camera/snapshots.ts); no Node imports.
 */
import type { CameraSettings } from './types.ts';

export interface FrameJob { channel: number; off: number; file: string; video?: boolean }
const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Seconds into the minute of n frames, evenly spread: 3 -> [0, 20, 40].
 *
 * @param count - `number` value.
 * @returns `number[]` result.
 */
export const frameOffsets = (count: number): number[] => Array.from({ length: count }, (_, i) => Math.floor((i * 60) / count));

/**
 * A video's first-frame picture: ch<N>.mp4 -> ch<N>.jpg.
 *
 * @param file - File path or filename.
 * @returns `string` result.
 */
export const posterFile = (file: string): string => String(file).replace(/\.mp4$/, '.jpg');

/** Transaction event types that never get camera footage (camera-log.ts footageApplies says which and why). */
export const NO_FOOTAGE_EVENTS = ['RS232', 'Modem-to-Modem', 'Modem', 'Hold Begin', 'Hold End', 'APB Re-Sync', 'APB Counter'];

/**
 * Each channel's frames for a minute: [{ channel, off, file, video }], off in seconds from the minute's start.
 * Frames after the minute (framesAfter) are at 60 + their offset, named ch<N>-a<SS>.jpg. Video mode: one
 * ch<N>.mp4 per channel from the minute's start.
 *
 * @param cfg - Configuration or settings object.
 * @returns `FrameJob[]` result.
 */
export const frameJobs = (cfg: Pick<CameraSettings, 'mode' | 'channels' | 'frames' | 'framesAfter'>): FrameJob[] => (cfg.mode === 'video'
  ? cfg.channels.map(({ channel }) => ({ channel, off: 0, file: `ch${channel}.mp4`, video: true }))
  : cfg.channels.flatMap(({ channel }) => [
    ...frameOffsets(cfg.frames).map((second) => ({ channel, off: second, file: `ch${channel}-${pad(second)}.jpg` })),
    ...frameOffsets(cfg.framesAfter || 0).map((second) => ({ channel, off: 60 + second, file: `ch${channel}-a${pad(second)}.jpg` })),
  ]));
