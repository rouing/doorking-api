// Server log: one line per entry, printed to the console (journalctl) and appended to a text file (by default
// logs/debug.log in the project), which is moved to debug.log.1 once it passes maxBytes. Always on; there is no page
// for it (yet). Callers mask secrets before writing.
import fs from 'node:fs';
import path from 'node:path';

export interface DebugLog {
  write(area: string, message: unknown): void;
  file: string;
}

// Returns { write(area, message), file }. toConsole false: the file only (tests).
export function createDebugLog(file: string, { maxBytes = 5 * 1024 * 1024, toConsole = true }: { maxBytes?: number; toConsole?: boolean } = {}): DebugLog {
  function write(area: string, message: unknown): void {
    const lines = String(message).split(/\r?\n/).filter((l) => l.trim()).join(' | ');
    if (toConsole) console.log(`[${area}] ${lines}`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(file, `${new Date().toISOString()} [${area}] ${lines}\n`);
    } catch (e) { console.error(`Log file not written: ${(e as Error).message}`); }
  }
  return { write, file };
}
