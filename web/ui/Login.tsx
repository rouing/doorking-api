import { useState, type FormEvent } from 'react';
import { Button, Callout, Card, Checkbox, Container, Flex, Heading, Link, Text, TextField } from '@radix-ui/themes';
import { browserSupportsWebAuthn, sendSignal, startAuthentication, type AuthenticationResponseJSON } from '@simplewebauthn/browser';
import type { SsoProviderInfo } from '../../src/types.ts';
import { api, ApiError, errorText, lsGet, lsSet } from './api.ts';
import { passkeyError, savePasskeyAfterSignIn } from './account/Passkeys.tsx';
import { usePasskeyAutofill, type PasskeyOptions } from './account/passkeyAutofill.ts';
import { ForgotPassword } from './account/SignInPages.tsx';
import { startSso } from './account/SingleSignOn.tsx';

interface LoginProps {
  onSignedIn: () => void;
  emailEnabled: boolean;
  sso: SsoProviderInfo[];
}

// Sign in with a local account (gate admins create them), a passkey, or a single sign-on provider. "Remember user"
// keeps only the username in this browser. Passkeys are also offered in the username box's suggestions (autofill),
// and after a password sign-in the browser may save one by itself (savePasskeyAfterSignIn).
export function Login({ onSignedIn, emailEnabled, sso }: LoginProps) {
  const [forgot, setForgot] = useState(false);
  const [remember, setRemember] = useState(() => lsGet('dk-remember-user', false));
  const [user, setUser] = useState(() => (remember ? lsGet('dk-user', '') : ''));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Signs in with the browser's passkey answer. A passkey the server doesn't know (removed here) is reported to the
  // browser, which then stops offering it (Chrome 132 and later).
  async function passkeySession(optionsJSON: PasskeyOptions, response: AuthenticationResponseJSON) {
    try {
      await api('POST', '/api/passkey/session', { response });
    } catch (err) {
      if (err instanceof ApiError && err.body.unknownCredential) {
        sendSignal({ signalName: 'unknownCredential', rpID: optionsJSON.rpId || window.location.hostname, credentialID: response.id })
          .catch(() => { /* not supported */ });
      }
      throw err;
    }
    onSignedIn();
  }

  const autofill = usePasskeyAutofill({
    enabled: !forgot,
    onAnswer: async (optionsJSON, response) => { setBusy(true); setError(''); await passkeySession(optionsJSON, response); },
    onError: (err) => { setError(passkeyError(err)); setBusy(false); },
  });

  // Passkey sign-in with the button: no username needed, the browser offers this site's passkeys.
  const withPasskey = () => autofill.whilePaused(async () => {
    setBusy(true);
    setError('');
    try {
      const optionsJSON = await api<PasskeyOptions>('POST', '/api/passkey/options', {});
      await passkeySession(optionsJSON, await startAuthentication({ optionsJSON }));
    } catch (err) { setError(passkeyError(err)); }
    setBusy(false);
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/session', { user, password });
      lsSet('dk-remember-user', remember);
      lsSet('dk-user', remember ? user : '');
      setPassword('');
      onSignedIn();
      savePasskeyAfterSignIn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container size="1" p={{ initial: '3', sm: '6' }} pt={{ initial: '5', sm: '6' }}>
      <Card size={{ initial: '2', sm: '3' }}>
        {forgot ? <><Heading mb="3">Reset your password</Heading><ForgotPassword onBack={() => setForgot(false)} /></> : (
        <form onSubmit={submit} autoComplete="off">
          <Flex direction="column" gap="3">
            <Heading>DoorKing Gate Data</Heading>
            <Text color="gray">Sign in with the account a gate admin created for you. New here? Read the <Link href="/help" target="_blank" rel="noopener">user guide</Link>.</Text>
            <label>
              <Text size="2" weight="medium">Username</Text>
              <TextField.Root value={user} onChange={(event) => setUser(event.target.value)} required autoComplete="username webauthn" />
            </label>
            <Text as="label" size="2">
              <Flex gap="2" align="center">
                <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} /> Remember user
              </Flex>
            </Text>
            <label>
              <Text size="2" weight="medium">Password</Text>
              <TextField.Root type="password" value={password} onChange={(event) => setPassword(event.target.value)} required
                autoComplete="current-password" />
            </label>
            <Button type="submit" loading={busy}>Sign in</Button>
            {browserSupportsWebAuthn() && <Button type="button" variant="soft" disabled={busy} onClick={withPasskey}>Sign in with a passkey</Button>}
            {sso.map((provider) => (
              <Button key={provider.id} type="button" variant="soft" disabled={busy}
                onClick={() => { setError(''); startSso('/api/sso/start', { provider: provider.id }).catch((err) => setError(errorText(err))); }}>
                Sign in with {provider.name}
              </Button>
            ))}
            {emailEnabled && <Link href="#" size="2" onClick={(event) => { event.preventDefault(); setForgot(true); }}>Forgot your password?</Link>}
            {error && <Callout.Root color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
          </Flex>
        </form>
        )}
      </Card>
    </Container>
  );
}
