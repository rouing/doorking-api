import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Code, Flex, IconButton, Select, Text, TextField } from '@radix-ui/themes';
import type { DeviceRange } from '../../../src/types.ts';
import { formatPhoneDigits } from '../format.ts';
import { deviceNameFor, MAX_CARDS_PER_ENTRY } from '../../../src/shared.ts';
import { HelpTip } from '../HelpTip.tsx';

interface FieldProps {
  label: string;
  help?: string;
  children: ReactNode;
}

/**
 * A labelled form field; help: a key in HELP (or own text) shown as a "?" tip after the label.
 *
 * @param props - Component props.
 * @param props.label - Display label.
 * @param props.help - Key in `HELP` or literal help text.
 * @param props.children - Children.
 * @returns Rendered React element.
 */
export function Field({ label, help, children }: FieldProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Text size="2" weight="medium">{label}{help && <HelpTip of={help} />}</Text>
      {children}
    </label>
  );
}

type ChoiceOption = string | readonly [value: string, label: string];
interface ChoiceProps {
  value: string; options: readonly ChoiceOption[]; onChange: (value: string) => void; disabled?: boolean; size?: '1' | '2'; title?: string;
}

/**
 * A drop-down list; each option is a value shown as itself, or a [value, label] pair.
 *
 * @param props - Component props.
 * @param props.value - Input value.
 * @param props.options - Optional settings.
 * @param props.onChange - Callback invoked when the value changes.
 * @param props.disabled - Whether the control is disabled.
 * @param props.size - Byte length or count.
 * @param props.title - Title.
 * @returns Rendered React element.
 */
export function Choice({ value, options, onChange, disabled, size, title }: ChoiceProps) {
  return (
    <Select.Root size={size} value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger title={title} />
      <Select.Content>
        {options.map((option) => {
          const [v, label] = typeof option === 'string' ? [option, option] : option;
          return <Select.Item key={v} value={v}>{label}</Select.Item>;
        })}
      </Select.Content>
    </Select.Root>
  );
}

interface PhoneFieldProps {
  value: string;
  onChange: (v: string) => void;
}

/**
 * Phone input that formats as you type ((918) 555-0142, 1 (918) 555-0142 or 555-0142) and keeps the caret after
 * the same digit.
 * Backspace over a separator removes the digit before it.
 *
 * @param props - Component props.
 * @param props.value - Input value.
 * @param props.onChange - Callback invoked when the value changes.
 * @returns Rendered React element.
 */
export function PhoneField({ value, onChange }: PhoneFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <TextField.Root ref={ref} inputMode="tel" placeholder="(918) 555-0142" value={value} onChange={(event) => {
      const input = event.target;
      let before = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, '').length;
      let digits = input.value.replace(/\D/g, '');
      if ((event.nativeEvent as InputEvent).inputType === 'deleteContentBackward' && digits === value.replace(/\D/g, '') && before > 0) {
        digits = digits.slice(0, before - 1) + digits.slice(before);
        before -= 1;
      }
      const text = formatPhoneDigits(digits.slice(0, digits[0] === '1' ? 11 : 10));
      let pos = 0;
      for (let seen = 0; pos < text.length && seen < before; pos++) if (/\d/.test(text[pos])) seen++;
      caret.current = pos;
      onChange(text);
    }} />
  );
}

interface CardNumberProps {
  card: string;
  devices: DeviceRange[];
  duplicate?: boolean;
}

/**
 * A card number with its Device Association name as a tooltip; red when no range holds it. dup: the card is also
 * assigned to another directory code (red background).
 *
 * @param props - Component props.
 * @param props.card - Card.
 * @param props.devices - Configured Device Association card ranges.
 * @param [props.duplicate] - Duplicate.
 * @returns Rendered React element.
 */
export function CardNumber({ card, devices, duplicate = false }: CardNumberProps) {
  const dev = deviceNameFor(devices, card);
  return (
    <Code variant="ghost" color={dev ? undefined : 'red'}
      title={`${card} · ${dev || 'not in any device range'}${duplicate ? ' · ALSO ASSIGNED TO ANOTHER DIRECTORY CODE' : ''}`}
      style={{ minWidth: '4.5em', background: duplicate ? 'var(--red-a5)' : undefined }}>{card}</Code>
  );
}

interface CardListProps {
  cards: string[];
  devices: DeviceRange[];
  dups?: Set<string>;
}

/**
 * Card numbers as fixed-width items that wrap onto aligned rows; cards in `dups` are marked as duplicates.
 *
 * @param props - Component props.
 * @param props.cards - Raw `cards.bin` buffer or list of card numbers.
 * @param props.devices - Configured Device Association card ranges.
 * @param props.dups - Dups.
 * @returns Rendered React element.
 */
export function CardList({ cards, devices, dups }: CardListProps) {
  return (
    <Flex gap="1" wrap="wrap" style={{ maxWidth: '24rem' }}>
      {cards.map((card) => <CardNumber key={card} card={card} devices={devices} duplicate={Boolean(dups && dups.has(card))} />)}
    </Flex>
  );
}


interface CardsEditorProps {
  cards: string[];
  devices: DeviceRange[];
  onChange: (cards: string[]) => void;
}

/**
 * Device (card) list with remove buttons and an add box (device codes 00001-65407; leading zeros dropped, no duplicates,
 * at most MAX_CARDS_PER_ENTRY).
 *
 * @param props - Component props.
 * @param props.cards - Raw `cards.bin` buffer or list of card numbers.
 * @param props.devices - Configured Device Association card ranges.
 * @param props.onChange - Callback invoked when the value changes.
 * @returns Rendered React element.
 */
export function CardsEditor({ cards, devices, onChange }: CardsEditorProps) {
  const [add, setAdd] = useState('');
  const [error, setError] = useState('');
  const addNow = () => {
    const number = add.replace(/\D/g, '');
    if (!number) return;
    if (Number(number) < 1 || Number(number) > 65407) { setError('Device codes are 00001-65407'); return; }
    if (cards.includes(String(Number(number)))) { setAdd(''); return; }
    if (cards.length >= MAX_CARDS_PER_ENTRY) { setError(`At most ${MAX_CARDS_PER_ENTRY} cards per directory code`); return; }
    onChange([...cards, String(Number(number))]);
    setAdd('');
    setError('');
  };
  return (
    <Flex direction="column" gap="2">
      <Text size="2" weight="medium">Devices / cards<HelpTip of="cards" /></Text>
      <Flex gap="2" wrap="wrap">
        {cards.map((num, i) => {
          const dev = deviceNameFor(devices, num);
          return (
            <Flex key={num} align="center" gap="1" px="2" py="1" style={{ background: 'var(--gray-a3)', borderRadius: 'var(--radius-2)' }}>
              <Text size="2">{num}</Text>
              <Text size="1" color={dev ? 'gray' : 'red'}>{dev || 'no device'}</Text>
              <IconButton size="1" variant="ghost" color="gray" title="Remove device"
                onClick={() => onChange(cards.filter((_, j) => j !== i))}>✕</IconButton>
            </Flex>
          );
        })}
      </Flex>
      <Flex gap="2" align="center" wrap="wrap">
        <TextField.Root inputMode="numeric" placeholder="Card number" maxLength={5} value={add}
          onChange={(event) => setAdd(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addNow(); } }} />
        <Button variant="soft" color="gray" onClick={addNow} disabled={cards.length >= MAX_CARDS_PER_ENTRY}>Add device</Button>
        <Text size="1" color="gray">{cards.length} of {MAX_CARDS_PER_ENTRY}</Text>
        {error && <Text size="2" color="red">{error}</Text>}
      </Flex>
    </Flex>
  );
}
