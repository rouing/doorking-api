import fs from 'node:fs';
import { ArchiveReader } from './carchive.ts';

export interface TraTransaction {
  date: string;
  time: string;
  timestamp: string;
  type: string;
  code: string;
  name: string;
  result: string;
  relay: string;
}

export interface TraFile { lastMarker: string; version: string; transactions: TraTransaction[] }

/**
 * TRANS*.TRA ("VERSION 54"): transaction log of CTran54Record objects, newest first.
 * The first 12 bytes are the "last received" marker that is sent back to DKS Cloud
 * as TransactionBytes so only newer transactions are downloaded.
 *
 * @param buffer - Binary board file buffer.
 * @returns `TraFile` result.
 * @throws Error when validation or the underlying operation fails.
 */
export function parseTraFile(buffer: Buffer): TraFile {
  const reader = new ArchiveReader(buffer);
  const lastMarker = reader.bytes(12).toString('hex');
  const version = reader.string();
  const count = reader.u16();
  const transactions: TraTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const className = reader.classTag();
    if (className !== 'CTran54Record') {
      throw new Error(`Unexpected class ${className} in transaction file`);
    }
    const date = reader.string().trim();
    const time = reader.string().trim();
    const transaction = {
      date,
      time,
      timestamp: toIsoTimestamp(date, time),
      type: reader.string(),
      code: reader.string(),
      name: reader.string().trimEnd(),
      result: reader.string(),
      relay: reader.string(),
    };
    reader.string();
    reader.i16();
    reader.u8();
    transactions.push(transaction);
  }
  if (!reader.eof) {
    throw new Error(`Transaction file has ${buffer.length - reader.pos} unread bytes`);
  }
  return { lastMarker, version, transactions };
}

/**
 * "6/22/26" + "11:39PM" -> "2026-06-22 23:39"
 *
 * @param date - `string` value.
 * @param time - `string` value.
 * @returns `string` result.
 */
export function toIsoTimestamp(date: string, time: string): string {
  const day = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(date);
  const clock = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(time);
  if (!day || !clock) return '';
  let hour = Number(clock[1]) % 12;
  if (clock[3].toUpperCase() === 'P') hour += 12;
  const pad = (value: number | string) => String(value).padStart(2, '0');
  return `20${day[3]}-${pad(day[1])}-${pad(day[2])} ${pad(hour)}:${clock[2]}`;
}

/**
 * Read tra file.
 *
 * @param path - `string` value.
 * @returns `TraFile` result.
 */
export function readTraFile(path: string): TraFile {
  return parseTraFile(fs.readFileSync(path));
}
