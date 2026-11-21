// Snapshot file names shared by the server (cameras.ts) and the page (web/ui/camera/snapshots.ts); no Node imports.

// Seconds into the minute of n frames, evenly spread: 3 -> [0, 20, 40].
export const frameOffsets = (n: number): number[] => Array.from({ length: n }, (_, i) => Math.floor((i * 60) / n));

// A video's first-frame picture: ch<N>.mp4 -> ch<N>.jpg.
export const posterFile = (file: string): string => String(file).replace(/\.mp4$/, '.jpg');
