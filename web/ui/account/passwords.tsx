// Password rules and the change-password form.
import { useState, type FormEvent } from 'react';
import { Button, Flex, Text, TextField } from '@radix-ui/themes';
import { api, errorText } from '../api.ts';
import { Field } from '../panes/fields.tsx';
import { PASSWORD_MIN } from '../../../src/shared.ts';

// New password twice; returns an error message, or '' when they are fine.
export const passwordProblem = (password: string, again: string) => (password.length < PASSWORD_MIN ? `The password must be at least ${PASSWORD_MIN} characters.`
  : password !== again ? 'The two passwords differ.' : '');

interface PasswordFormProps {
  onChanged: () => void;
  submitLabel: string;
}

// Current password and a new one twice. onChanged runs after the server accepted it.
export function PasswordForm({ onChanged, submitLabel }: PasswordFormProps) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setInfo(problem); return; }
    setBusy(true);
    try {
      await api('PUT', '/api/me/password', { current, password });
      setCurrent(''); setPassword(''); setAgain('');
      setInfo('Password changed. You were signed out everywhere else.');
      onChanged();
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} autoComplete="off">
      <Flex direction="column" gap="3" style={{ maxWidth: 360 }}>
        <Field label="Current password">
          <TextField.Root type="password" value={current} onChange={(event) => setCurrent(event.target.value)} required autoComplete="current-password" />
        </Field>
        <Field label={`New password (at least ${PASSWORD_MIN} characters)`}>
          <TextField.Root type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
        </Field>
        <Field label="New password again">
          <TextField.Root type="password" value={again} onChange={(event) => setAgain(event.target.value)} required autoComplete="new-password" />
        </Field>
        <Flex gap="3" align="center" wrap="wrap"><Button type="submit" loading={busy}>{submitLabel}</Button><Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </form>
  );
}
