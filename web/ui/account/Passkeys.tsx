// Passkeys: the step-up dialog for sensitive actions and the user's passkey list.
import { useEffect, useState, type FormEvent } from 'react';
import { AlertDialog, Badge, Button, Card, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import { browserSupportsWebAuthn, getBrowserCapabilities, sendSignal, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '../../../src/types.ts';
import { api, errorText, onStepUp } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import { Field } from '../panes/fields.tsx';
import { ApproveDevice, APPROVAL_KEY } from './ApproveDevice.tsx';

// A readable message for a failed passkey step (the browser's "not allowed" also means the user cancelled).
export function passkeyError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey request was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  return errorText(err);
}
interface PasskeysReply { passkeys: PasskeyInfo[]; userHandle: string | null }

// Tells the browser which of the account's passkeys still work on this site, so the phone or password manager stops
// offering removed ones (Chrome 132 and later; other browsers skip it).
function syncWithBrowser(reply: PasskeysReply): void {
  if (!reply.userHandle) return;
  const rpID = window.location.hostname;
  sendSignal({ signalName: 'allAcceptedCredentials', rpID, userID: reply.userHandle,
    allAcceptedCredentialIDs: reply.passkeys.filter((passkey) => passkey.site === rpID).map((passkey) => passkey.id) }).catch(() => { /* not supported */ });
}

// Right after a password sign-in: lets the password manager that filled in the password save a passkey by itself,
// without a prompt (Chrome 136 and later, where the browser supports it). Only the account's first passkey; the
// server refuses otherwise, and any failure is ignored.
export async function savePasskeyAfterSignIn(): Promise<void> {
  try {
    if (!browserSupportsWebAuthn() || (await getBrowserCapabilities()).conditionalCreate !== 'supported') return;
    const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('POST', '/api/me/passkeys/options', { auto: true });
    const response = await startRegistration({ optionsJSON, useAutoRegister: true });
    syncWithBrowser(await api<PasskeysReply>('POST', '/api/me/passkeys', { name: 'Saved after sign-in', response, auto: true }));
  } catch { /* not this time */ }
}

// The "Confirm it's you" dialog for sensitive actions (a 403 { stepUp } reply, see api.ts onStepUp): confirms with
// one of the user's passkeys, then the action is retried. Without a passkey it says to add one. Render once.
export function StepUpDialog() {
  const [ask, setAsk] = useState<{ hasPasskey: boolean; resolve: (ok: boolean) => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  useEffect(() => {
    onStepUp((reply) => new Promise<boolean>((resolve) => { setInfo(''); setAsk({ hasPasskey: reply.hasPasskey === true, resolve }); }));
    return () => onStepUp(async () => false);
  }, []);
  const close = (ok: boolean) => { ask?.resolve(ok); setAsk(null); setBusy(false); };
  useBackLayer(ask !== null, () => close(false));
  async function confirmIt() {
    setBusy(true);
    setInfo('Follow your browser\'s prompt…');
    try {
      const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('POST', '/api/me/step-up/options', {});
      await api('POST', '/api/me/step-up', { response: await startAuthentication({ optionsJSON }) });
      close(true);
    } catch (err) { setInfo(passkeyError(err)); setBusy(false); }
  }
  return (
    <AlertDialog.Root open={ask !== null} onOpenChange={(open) => { if (!open) close(false); }}>
      <AlertDialog.Content maxWidth="480px" aria-describedby={undefined}>
        <AlertDialog.Title>{ask?.hasPasskey ? 'Confirm it\'s you' : 'A passkey is needed'}</AlertDialog.Title>
        <Text as="p" size="2">
          {ask?.hasPasskey
            ? 'Changes like this one need a quick confirmation with your passkey (fingerprint, face or device PIN). It covers your next changes for a few hours. No passkey on this device? In the browser\'s prompt, choose a phone or tablet and scan its QR code with the phone that has your passkey.'
            : 'Changes like this one need a passkey. Add one in User Settings, under Passkeys, then try again.'}
        </Text>
        {info && <Text as="p" size="2" color="gray" mt="2">{info}</Text>}
        <Flex gap="3" mt="4" justify="end">
          <Button variant="soft" color="gray" onClick={() => close(false)}>{ask?.hasPasskey ? 'Cancel' : 'Close'}</Button>
          {ask?.hasPasskey && <Button loading={busy} onClick={confirmIt} disabled={!browserSupportsWebAuthn()}>Confirm with passkey</Button>}
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

interface PasskeysProps {
  askPassword: boolean;
  stepUpMinutes: number;
}

// The user's passkeys: add (after confirming the password, when the account has one), rename, remove. Passkeys work on the
// site name they were made on: the public HTTPS name, or localhost on the server.
export function Passkeys({ askPassword, stepUpMinutes }: PasskeysProps) {
  const [list, setList] = useState<PasskeyInfo[]>([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [approval, setApproval] = useState(() => sessionStorage.getItem(APPROVAL_KEY) || ''); // a code from another device
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();
  const show = (reply: PasskeysReply) => { setList(reply.passkeys); syncWithBrowser(reply); };
  const load = () => api<PasskeysReply>('GET', '/api/me/passkeys').then(show, (err) => setInfo(errorText(err)));
  useEffect(() => { load(); }, []);
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setInfo('Follow your browser\'s prompt…');
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('POST', '/api/me/passkeys/options',
        approval.trim() ? { approval } : { password });
      setPassword('');
      const response = await startRegistration({ optionsJSON });
      show(await api<PasskeysReply>('POST', '/api/me/passkeys', { name: name.trim(), response }));
      setName('');
      setApproval('');
      sessionStorage.removeItem(APPROVAL_KEY);
      setInfo('Passkey added. You can now use "Sign in with a passkey".');
    } catch (err) { setInfo(passkeyError(err)); }
    setBusy(false);
  }
  const rename = async (passkey: PasskeyInfo) => {
    const next = window.prompt('Name for this passkey', passkey.name);
    if (next === null || !next.trim() || next.trim() === passkey.name) return;
    try { show(await api<PasskeysReply>('PUT', `/api/me/passkeys/${encodeURIComponent(passkey.id)}`, { name: next.trim() })); } catch (err) { setInfo(errorText(err)); }
  };
  const remove = async (passkey: PasskeyInfo) => {
    if (!await confirm({ title: `Remove the passkey "${passkey.name}"?`, action: 'Remove', color: 'red',
      body: 'It will no longer sign you in. Also delete it from the device or password manager that holds it.' })) return;
    try { show(await api<PasskeysReply>('DELETE', `/api/me/passkeys/${encodeURIComponent(passkey.id)}`)); setInfo(`Removed "${passkey.name}".`); } catch (err) { setInfo(errorText(err)); }
  };
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Passkeys</Heading>
        <Text size="2" color="gray">
          Sign in with your fingerprint, face or device PIN instead of typing your password. Your other ways to sign in keep working too. A
          passkey works on the address it was added on ({window.location.host}).
        </Text>
        <Text size="2" color="gray">
          Sending changes to a gate, scheduled transfers, gate users, API keys, the gate's DKS login and linking a sign-in need a passkey: you
          confirm with it, and that covers your changes for {stepUpMinutes % 60 ? `${stepUpMinutes} minutes` : `${stepUpMinutes / 60} hours`}.
        </Text>
        {list.length > 0 && (
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>{['Name', 'Works on', 'Added', 'Last used', ''].map((header, i) => <Table.ColumnHeaderCell key={i}>{header}</Table.ColumnHeaderCell>)}</Table.Row>
            </Table.Header>
            <Table.Body>
              {list.map((passkey) => (
                <Table.Row key={passkey.id} align="center">
                  <Table.Cell>{passkey.name}{passkey.synced && <Badge ml="2" color="gray" title="Backed up by your passkey provider, so it is on your other devices too">synced</Badge>}</Table.Cell>
                  <Table.Cell>{passkey.site}</Table.Cell>
                  <Table.Cell>{fmtTime(passkey.createdAt)}</Table.Cell>
                  <Table.Cell>{passkey.lastUsedAt ? fmtTime(passkey.lastUsedAt) : 'never'}</Table.Cell>
                  <Table.Cell><Flex gap="2">
                    <Button size="1" variant="soft" color="gray" onClick={() => rename(passkey)}>Rename</Button>
                    <Button size="1" variant="soft" color="red" onClick={() => remove(passkey)}>Remove</Button>
                  </Flex></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
        {browserSupportsWebAuthn() ? (
          <form onSubmit={add} autoComplete="off">
            <Flex gap="3" align="end" wrap="wrap">
              <Field label="Name (e.g. iPhone, YubiKey)"><TextField.Root value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></Field>
              {list.length > 0 && (
                <Field label="Approval code (from another device)" help="approvalCode">
                  <TextField.Root value={approval} maxLength={12} placeholder="ABCD-EFGH" autoComplete="one-time-code"
                    onChange={(event) => setApproval(event.target.value)} />
                </Field>
              )}
              {askPassword && !approval.trim() && <Field label="Your current password"><TextField.Root type="password" value={password}
                required={!list.length} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} /></Field>}
              <Button type="submit" loading={busy}>Add a passkey</Button>
            </Flex>
          </form>
        ) : <Text size="2" color="gray">This browser doesn't support passkeys.</Text>}
        {info && <Text size="2" color="gray">{info}</Text>}
        {list.length > 0 && <ApproveDevice />}
      </Flex>
    </Card>
  );
}
