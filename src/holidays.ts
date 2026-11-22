/**
 * @module src/holidays
 *
 * US holidays for the WebUI holiday picker. The gate stores only month/day (no year and no name), so names are never
 * persisted: fixed-date holidays keep the same M/D every year, while floating US holidays (MLK Day, Presidents' Day,
 * Memorial Day, Labor Day, Columbus Day, Thanksgiving) are computed for a selected calendar year.
 */
export interface Holiday { name: string; month: number; day: number }

export const FIXED_HOLIDAYS: Holiday[] = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: 'Valentine’s Day', month: 2, day: 14 },
  { name: "St. Patrick's Day", month: 3, day: 17 },
  { name: 'Juneteenth', month: 6, day: 19 },
  { name: 'Independence Day', month: 7, day: 4 },
  { name: 'Halloween', month: 10, day: 31 },
  { name: 'Veterans Day', month: 11, day: 11 },
  { name: 'Christmas Eve', month: 12, day: 24 },
  { name: 'Christmas Day', month: 12, day: 25 },
  { name: "New Year's Eve", month: 12, day: 31 },
];

/**
 * Day of the month for the `nth` occurrence (1-based) of `weekday` (0 = Sun .. 6 = Sat) in `month` (1–12).
 *
 * @param year - Four-digit calendar year.
 * @param month - Calendar month (1–12).
 * @param weekday - Day of week (0 = Sunday .. 6 = Saturday).
 * @param nth - Occurrence number (1 = first, 2 = second, etc.).
 * @returns Day of month (1–31).
 */
function nthWeekday(year: number, month: number, weekday: number, nth: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (nth - 1) * 7;
}

/**
 * Day of the month for the last occurrence of `weekday` (0 = Sun .. 6 = Sat) in `month` (1–12).
 *
 * @param year - Four-digit calendar year.
 * @param month - Calendar month (1–12).
 * @param weekday - Day of week (0 = Sunday .. 6 = Saturday).
 * @returns Day of month (1–31).
 */
function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  const diff = (last.getUTCDay() - weekday + 7) % 7;
  return last.getUTCDate() - diff;
}

/**
 * Computes floating US holidays for `year` and merges them with `FIXED_HOLIDAYS` in calendar order.
 *
 * @param year - Four-digit calendar year.
 * @returns Chronologically ordered list of US holidays for `year`.
 */
export function usHolidaysForYear(year: number): Holiday[] {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  const floating: Holiday[] = [
    { name: 'Martin Luther King Jr. Day', month: 1, day: nthWeekday(year, 1, 1, 3) },
    { name: "Presidents' Day", month: 2, day: nthWeekday(year, 2, 1, 3) },
    { name: 'Memorial Day', month: 5, day: lastWeekday(year, 5, 1) },
    { name: 'Labor Day', month: 9, day: nthWeekday(year, 9, 1, 1) },
    { name: 'Columbus Day', month: 10, day: nthWeekday(year, 10, 1, 2) },
    { name: 'Thanksgiving', month: 11, day: thanksgiving },
    { name: 'Day after Thanksgiving', month: 11, day: thanksgiving + 1 },
  ];
  return [...FIXED_HOLIDAYS, ...floating].sort((first, second) => first.month - second.month || first.day - second.day);
}
