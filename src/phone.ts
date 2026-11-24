/**
 * @module src/phone
 *
 * North American phone parsing and display formatting backed by `libphonenumber-js` (with 7-digit local support
 * for DoorKing boards).
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface NanpPhoneParts {
  areaCode: string;
  phone: string;
}

/**
 * Parses a 7-, 10-, or 11-digit (leading `1`) North American phone number into DoorKing board fields (`areaCode` + 7-digit
 * local `phone`). Returns `null` when the digit count is not a valid NANP number.
 */
export function parseNanpPhone(raw: string, { keepLeadingOne = false }: { keepLeadingOne?: boolean } = {}): NanpPhoneParts | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 7) return { areaCode: '', phone: digits };
  const parsed = parsePhoneNumberFromString(String(raw || ''), 'US');
  if (parsed && parsed.countryCallingCode === '1' && parsed.nationalNumber.length === 10) {
    const area = parsed.nationalNumber.slice(0, 3);
    const local = parsed.nationalNumber.slice(3);
    const hasLeadingOne = digits.length === 11 && digits[0] === '1';
    return { areaCode: keepLeadingOne && hasLeadingOne ? `1${area}` : area, phone: local };
  }
  if (digits.length === 11 && digits[0] === '1') {
    return { areaCode: keepLeadingOne ? digits.slice(0, 4) : digits.slice(1, 4), phone: digits.slice(4) };
  }
  if (digits.length === 10) return { areaCode: digits.slice(0, 3), phone: digits.slice(3) };
  return null;
}

/**
 * Formats 7-, 10-, or 11-digit North American phone numbers cleanly (`(214) 555-0142` or `555-0142`).
 */
export function fmtPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  const parsed = parsePhoneNumberFromString(String(raw || ''), 'US');
  if (parsed && parsed.countryCallingCode === '1' && parsed.nationalNumber.length === 10) {
    return digits.length === 11 && digits[0] === '1'
      ? `1 ${parsed.formatNational()}`
      : parsed.formatNational();
  }
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw;
}
