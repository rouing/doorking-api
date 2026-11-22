/**
 * @module src/shared
 *
 * Limits and rules used by both the server and the page (web/ui); no Node imports. The server enforces them, the page
 * uses them to check input early and to word its messages.
 */
import type { DeviceRange, GateConfig, ScheduleAction } from './types.ts';

export const PASSWORD_MIN = 12; // characters in an account password
export const NOTE_MAX = 500; // characters in a directory code's local note
/**
 * Cards (device numbers) one directory code may hold: DoorKing32 refuses more ("You can only add up to 25 additional
 * device numbers"; its export has 25 device columns).
 */
export const MAX_CARDS_PER_ENTRY = 25;
/** The gate configuration fields kept in prefs (PUT /prefs gateConfig), in the order the page shows them. */
export const GATE_CONFIG_KEYS: (keyof GateConfig)[] = ['siteName', 'memorySize', 'areaCodes', 'modelNumber', 'antiPassBack', 'interface1816'];
/** A schedule's transfers, in the order they run. */
export const SCHEDULE_ACTIONS: ScheduleAction[] = ['send', 'residents', 'transactions', 'snapshots'];
/** Device Association until a gate's ranges are saved: every card number is a "Cards" event. */
export const DEFAULT_DEVICE_ASSOCIATION: DeviceRange[] = [{ name: 'Cards', from: '00001', to: '65407' }];

/**
 * Device name for a card number, as DoorKing32 shows it in a card transaction's Event Type: the first row whose
 * From-To range holds the number, else '' (DoorKing32 shows a blank).
 *
 * @param rows - List of data rows.
 * @param card - `number | string` value.
 * @returns `string` result.
 */
export function deviceNameFor(rows: DeviceRange[] | null | undefined, card: number | string): string {
  const number = Number(card);
  const device = (rows || []).find((range) => number >= Number(range.from) && number <= Number(range.to));
  return device ? device.name : '';
}
