// The signed-in user's own settings page.
import { useState } from 'react';
import { Badge, Button, Card, Checkbox, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { api, errorText } from '../api.ts';
import { fmtIntlPhone } from '../format.ts';
import type { SignedIn } from '../App.tsx';
import { Field } from '../panes/fields.tsx';
import { Passkeys } from './Passkeys.tsx';
import { SingleSignOn } from './SingleSignOn.tsx';
import { PasswordForm } from './passwords.tsx';

// The signed-in user's own settings: dark mode, email and password. onSaved reloads the session (dark mode).
export function UserSettings({ session, onSaved }: { session: SignedIn; onSaved: () => void }) {
  const [email, setEmail] = useState(session.pendingEmail || session.email);
  const [emailPassword, setEmailPassword] = useState('');
  const [phone, setPhone] = useState(fmtIntlPhone(session.phone));
  const [info, setInfo] = useState('');
  const [phoneInfo, setPhoneInfo] = useState('');
  const savePhone = async () => {
    try {
      const reply = await api<{ phone: string }>('PUT', '/api/me', { phone: phone.trim() });
      setPhone(fmtIntlPhone(reply.phone));
      setPhoneInfo(reply.phone ? `Saved as ${fmtIntlPhone(reply.phone)}.` : 'Phone number removed.');
      onSaved();
    } catch (err) { setPhoneInfo(`Not saved: ${errorText(err)}`); }
  };
  const save = async (body: Record<string, unknown>, done: string) => {
    try {
      const reply = await api<{ warning?: string }>('PUT', '/api/me', body);
      setInfo(reply.warning || done);
      onSaved();
    } catch (err) { setInfo(`Not saved: ${errorText(err)}`); }
  };
  const resend = async () => {
    try { await api('POST', '/api/me/email/resend', {}); setInfo(`Confirmation link sent again to ${session.pendingEmail}.`); } catch (err) { setInfo(errorText(err)); }
  };
  const next = email.trim().toLowerCase();
  const emailChanges = next !== session.email && next !== session.pendingEmail; // needs the current password
  return (
    <Flex direction="column" gap="4">
      <Heading>User Settings</Heading>
      <Text size="2" color="gray">Settings for your account, <strong>{session.user}</strong>. They follow you to any browser you sign in from.</Text>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Appearance</Heading>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={session.dark} onCheckedChange={(v) => save({ dark: v === true }, '')} /> Dark mode
          </Flex></Text>
        </Flex>
      </Card>
      <Card>
        <Flex direction="column" gap="3" style={{ maxWidth: 480 }}>
          <Heading size="3">Email</Heading>
          <Text size="2" color="gray">
            Used for password resets, security alerts and notifications. Each email can belong to one account only. A new address works
            once you open the confirmation link sent to it.
          </Text>
          {session.email && <Text size="2">Confirmed: <strong>{session.email}</strong> <Badge color="green">confirmed</Badge></Text>}
          {session.pendingEmail && (
            <Flex gap="2" align="center" wrap="wrap">
              <Text size="2">Waiting for confirmation: <strong>{session.pendingEmail}</strong> <Badge color="amber">check your inbox</Badge></Text>
              {session.emailEnabled && <Button size="1" variant="soft" onClick={resend}>Send the link again</Button>}
            </Flex>
          )}
          {!session.emailEnabled && <Text size="2" color="amber">This server can't send email yet, so addresses can't be confirmed for now.</Text>}
          <TextField.Root type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          {session.hasPassword && emailChanges && (
            <Field label="Your current password"><TextField.Root type="password" value={emailPassword} autoComplete="current-password"
              onChange={(event) => setEmailPassword(event.target.value)} /></Field>
          )}
          <Flex gap="3" align="center">
            <Button onClick={() => save({ email: next, ...(emailChanges && { password: emailPassword }) }, !next ? 'Email removed.' : next === session.email ? 'Saved.' : `Saved. Open the link we sent to ${next} to confirm it.`)}>Save email</Button>
            <Text size="2" color="gray">{info}</Text>
          </Flex>
        </Flex>
      </Card>
      <Card>
        <Flex direction="column" gap="3" style={{ maxWidth: 480 }}>
          <Heading size="3">Phone</Heading>
          <Text size="2" color="gray">
            Optional. Admins of your gates can see it, to reach you. A 10-digit number is taken as US/Canada; for other countries start
            with + and the country code.
          </Text>
          <TextField.Root type="tel" inputMode="tel" value={phone} placeholder="(214) 555-0100 or +44 20 7946 0958" onChange={(event) => setPhone(event.target.value)} />
          <Flex gap="3" align="center"><Button onClick={savePhone}>Save phone</Button><Text size="2" color="gray">{phoneInfo}</Text></Flex>
        </Flex>
      </Card>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Email notifications</Heading>
          <Text size="2" color="gray">Sent to your confirmed email. Security emails (password or passkey changes, password resets) are always sent.</Text>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={session.notifyAccess} onCheckedChange={(v) => save({ notifyAccess: v === true }, '')} />
            When I'm given access to a gate, removed from one, or my role changes
          </Flex></Text>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={session.notifyAlerts} onCheckedChange={(v) => save({ notifyAlerts: v === true }, '')} />
            Gate alerts for gates I'm admin of (a send or scheduled transfer failed)
          </Flex></Text>
        </Flex>
      </Card>
      <SingleSignOn session={session} />
      <Passkeys askPassword={session.hasPassword} stepUpMinutes={session.stepUpMinutes} />
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Password</Heading>
          {!session.passwordAllowed ? (
            <Text size="2" color="gray">password sign-in is turned off for your account: you sign in with single sign-on (or a passkey).</Text>
          ) : !session.hasPassword ? (
            <Text size="2" color="gray">
              Your account has no password: you sign in with single sign-on (or a passkey). To set one, use "Forgot your password?" on the
              sign-in page; it needs a confirmed email.
            </Text>
          ) : (
            <>
              <Text size="2" color="gray">Only you can change your password. Changing it signs you out on every other browser.</Text>
              <PasswordForm submitLabel="Change password" onChanged={() => {}} />
            </>
          )}
        </Flex>
      </Card>
    </Flex>
  );
}
