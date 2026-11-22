import { useState } from 'react';
import { Button, Flex, Grid, Heading, Text, TextArea, TextField } from '@radix-ui/themes';
import type { DeviceRange, GateFeatures, ResidentRow } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { phoneFull, securityText } from '../format.ts';
import { CardsEditor, Choice, Field, PhoneField } from './fields.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { NOTE_MAX } from '../../../src/shared.ts';


/**
 * Directory codes 0 and 1 (000, 001, ...) always get the maximum talk time; the DoorKing manual keeps them for the
 * manager's office or an emergency number, so new entries aren't offered them first.
 *
 * @param code - Directory code string.
 * @returns Computed result.
 */
const reservedCode = (code: string) => /^\d+$/.test(code) && Number(code) <= 1;

interface ResidentFormProps {
  resident: ResidentRow | null;
  vendor: boolean;
  dirDigits: number;
  emptyCodes: string[];
  devices: DeviceRange[];
  features: GateFeatures;
  gapi: GateApi;
  onDone: () => Promise<void>;
  onCancel?: () => void;
}

/**
 * Edits a resident (every field) or vendor (name, entry code, security level, cards) in the working copy, or adds a new one
 * (r null). Nothing goes to the gate until Send. Floor and elevator reference are hidden when the gate's features
 * turn them off; their values are kept.
 *
 * @param props - Component props.
 * @param props.resident - Resident/vendor row.
 * @param props.vendor - Whether the entry is a vendor.
 * @param props.dirDigits - Number of digits in directory codes (1–4).
 * @param props.emptyCodes - List of currently vacant directory codes.
 * @param props.devices - Configured Device Association card ranges.
 * @param props.features - Visible feature toggles (`floors`, `elevators`).
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onDone - Callback invoked when the action completes.
 * @param props.onCancel - Callback invoked when the user cancels.
 * @returns Rendered React element.
 */
export function ResidentForm({ resident, vendor, dirDigits, emptyCodes, devices, features, gapi, onDone, onCancel }: ResidentFormProps) {
  const [code, setCode] = useState(resident ? resident.directoryCode : emptyCodes.find((emptyCode) => !reservedCode(emptyCode)) || '');
  const [name, setName] = useState(resident ? resident.name : '');
  const [phone, setPhone] = useState(resident ? phoneFull(resident) : '');
  const [entryCode, setEntryCode] = useState(resident ? resident.entryCode : '');
  const [securityLevel, setSecurity] = useState(resident && resident.securityLevel !== '' ? String(resident.securityLevel) : '1');
  const [floor, setFloor] = useState(resident ? String(resident.floor) : '');
  const [elevatorRef, setElevator] = useState(String((resident && resident.elevatorRef) || 1));
  const [cards, setCards] = useState((resident ? resident.cards : []).map((card) => String(Number(card))));
  const [note, setNote] = useState(resident ? resident.note || '' : '');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const noun = vendor ? 'vendor' : 'resident';

  const run = async (busyText: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setInfo(busyText);
    try { await fn(); await onDone(); } catch (err) { setInfo(errorText(err)); setBusy(false); }
  };

  /**
   * The edit payload; the combined phone is split into area code (3 digits, or 1 + area code for long distance)
   * and the 7-digit number.
   *
   * @returns `Record<string, unknown> | null` result.
   */
  function payload(): Record<string, unknown> | null {
    const out: Record<string, unknown> = { name, entryCode, cards, securityLevel: Number(securityLevel || 0) };
    if (vendor) return out;
    const full = phone.replace(/\D/g, '');
    if (full && full.length !== 7 && full.length !== 10 && !(full.length === 11 && full[0] === '1')) {
      setInfo('Phone must be 7 digits, 10 with area code, or 11 starting with 1 for long distance.');
      return null;
    }
    return { ...out, areaCode: full.slice(0, -7), phone: full.slice(-7), floor, elevatorRef: Number(elevatorRef) };
  }

  /**
   * The note is local (not in the working copy), saved after the entry when it changed.
   *
   * @param dirCode - `string` value.
   * @returns Rendered React element.
   */
  const saveNote = (dirCode: string) => (note.trim() === ((resident && resident.note) || '') ? Promise.resolve()
    : gapi('PUT', `/residents/${encodeURIComponent(dirCode)}/note`, { note }));

  function save() {
    const body = payload();
    if (!body) return;
    if (note.trim().length > NOTE_MAX) { setInfo(`A note is at most ${NOTE_MAX} characters.`); return; }
    if (resident) {
      run('Saving…', async () => {
        await gapi('PUT', `/residents/${encodeURIComponent(resident.directoryCode)}`, { ...body, directoryCode: resident.directoryCode });
        await saveNote(resident.directoryCode);
      });
      return;
    }
    if (!new RegExp(`^\\d{${dirDigits}}$`).test(code)) { setInfo(`Enter a ${dirDigits}-digit directory code.`); return; }
    if (!name.trim()) { setInfo('A name is required.'); return; }
    run('Creating…', async () => {
      await gapi('POST', '/residents', { ...body, directoryCode: code, vendor });
      await saveNote(code);
    });
  }

  const who = resident ? `${resident.name || '(no name)'} · code ${resident.directoryCode}` : '';
  /** Delete: empties the slot (the directory code stays, as the gate marks an empty slot). */
  async function clearSlot() {
    if (!resident || !await confirm({ title: `Delete ${noun} "${who}"?`, action: `Delete ${noun}`, color: 'red',
      body: 'This clears the name, phone, entry code and all cards for this directory slot in the working copy. The slot (directory code) itself stays, matching how the gate marks an empty slot. Nothing is sent to the gate until you Send.' })) return;
    run('Deleting…', () => gapi('DELETE', `/residents/${encodeURIComponent(resident.directoryCode)}`));
  }
  /** Remove code: takes the directory code itself off the gate. */
  async function removeCode() {
    if (!resident || !await confirm({ title: `Remove directory code ${resident.directoryCode}?`, action: 'Remove code', color: 'red',
      body: `"${who}": this deletes the entry, phone record and all cards, and takes code ${resident.directoryCode} off the gate (it will no longer be a vacant slot). Nothing is sent to the gate until you Send.` })) return;
    run('Removing…', () => gapi('DELETE', `/directory-codes/${encodeURIComponent(resident.directoryCode)}`));
  }

  return (
    <Flex direction="column" gap="3" onClick={(event) => event.stopPropagation()}>
      {dialog}
      {!resident && <Heading size="3">Add {noun}</Heading>}
      <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
        {!resident && (
          <Field label="Directory code (vacant or new)" help="directoryCode">
            <TextField.Root inputMode="numeric" maxLength={dirDigits} placeholder={`e.g. ${'5'.repeat(dirDigits)}`} list="dk-empty-codes"
              value={code} onChange={(event) => setCode(event.target.value)} />
            <datalist id="dk-empty-codes">
              {[...emptyCodes.filter((emptyCode) => !reservedCode(emptyCode)), ...emptyCodes.filter(reservedCode)].map((code) => <option key={code} value={code} />)}
            </datalist>
            {reservedCode(code) && (
              <Text size="1" color="amber">Codes {'0'.padStart(dirDigits, '0')} and {'1'.padStart(dirDigits, '0')} always get the maximum talk time; best kept for the office or an emergency number.</Text>
            )}
          </Field>
        )}
        <Field label="Name"><TextField.Root maxLength={15} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        {!vendor && <Field label="Phone (area + number)"><PhoneField value={phone} onChange={setPhone} /></Field>}
        <Field label="Entry code" help="entryCode">
          <TextField.Root inputMode="numeric" maxLength={4} value={entryCode} onChange={(event) => setEntryCode(event.target.value)} />
        </Field>
        <Field label="Security level" help="securityLevel">
          <Choice value={securityLevel} onChange={setSecurity} options={Array.from({ length: 31 }, (_, i) => [String(i), securityText(i)] as const)} />
        </Field>
        {!vendor && (
          <>
            {features.floors && (
              <Field label="Floor (blank = none)" help="floor">
                <TextField.Root type="number" min={1} max={64} value={floor} onChange={(event) => setFloor(event.target.value)} />
              </Field>
            )}
            {features.elevators && (
              <Field label="Elevator reference" help="elevatorRef">
                <Choice value={elevatorRef} onChange={setElevator} options={Array.from({ length: 8 }, (_, i) => String(i + 1))} />
              </Field>
            )}
            <Text size="2" color="gray">
              <Flex gap="2" align="center" height="100%">
                {name.trim() && phone.replace(/\D/g, '') ? 'Shown in the entry-panel directory' : 'Hidden from the entry-panel directory (no phone number)'}
                <HelpTip of="hidden" />
              </Flex>
            </Text>
          </>
        )}
      </Grid>
      <CardsEditor cards={cards} devices={devices} onChange={setCards} />
      <Field label="Notes" help="notes">
        <TextArea maxLength={NOTE_MAX} rows={2} value={note} onChange={(event) => setNote(event.target.value)} style={{ maxWidth: 640 }} />
      </Field>
      <Flex gap="3" align="center" wrap="wrap">
        <Button onClick={save} disabled={busy}>{resident ? 'Save to working copy' : `Create ${noun}`}</Button>
        {resident && <Button color="red" variant="soft" onClick={clearSlot} disabled={busy}>Delete {noun}</Button>}
        {resident && <Button color="red" variant="soft" onClick={removeCode} disabled={busy}
          title="Delete the entry and take the directory code off the gate">Remove code</Button>}
        {onCancel && <Button variant="soft" color="gray" onClick={onCancel}>{resident ? 'Close editor' : 'Cancel'}</Button>}
        <Text size="2" color="gray">{info}</Text>
      </Flex>
    </Flex>
  );
}
