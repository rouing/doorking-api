/**
 * @module web/ui/account/SignInPages
 *
 * Pages shown before a normal sign-in: email links, forgotten password, first setup, forced password change.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Callout, Card, Container, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import type { SsoProviderInfo } from '../../../src/types.ts';
import { api, errorText } from '../api.ts';
import { Field } from '../panes/fields.tsx';
import { startSso } from './SingleSignOn.tsx';
import { PasswordForm, passwordProblem } from './passwords.tsx';
import { PASSWORD_MIN } from '../../../src/shared.ts';

interface EmailLinkProps {
  kind: 'verify' | 'reset' | 'invite';
  token: string;
  onDone: () => void;
  sso?: SsoProviderInfo[];
}

/**
 * The page an email link opens (#verify=, #reset=, #invite= in the address): confirms the email, or asks for a new
 * password (reset) or the first one (invitation, which also signs in; or accept it with a single sign-on provider, sso).
 * onDone clears the link and reloads the session.
 *
 * @param props - Component props.
 * @param props.kind - Item or operation kind.
 * @param props.token - One-time link token or session token.
 * @param props.onDone - Callback invoked when the action completes.
 * @param [props.sso] - Per-server SSO flow and discovery cache.
 * @returns Rendered React element.
 */
export function EmailLink({ kind, token, onDone, sso = [] }: EmailLinkProps) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [username, setUsername] = useState('');
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(kind !== 'reset');
  useEffect(() => {
    if (kind === 'verify') {
      api<{ email: string }>('POST', '/api/email/verify', { token })
        .then((reply) => setState({ ok: `Your email ${reply.email} is confirmed.` }), (err) => setState({ error: errorText(err) })).finally(() => setBusy(false));
      return;
    }
    if (kind === 'invite') {
      api<{ username: string }>('POST', '/api/invite/check', { token }).then((reply) => setUsername(reply.username), (err) => setState({ error: errorText(err) }))
        .finally(() => setBusy(false));
    }
  }, [kind, token]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setState({ error: problem }); return; }
    setBusy(true);
    try {
      if (kind === 'invite') { await api('POST', '/api/invite', { token, password }); onDone(); return; }
      const reply = await api<{ username: string }>('POST', '/api/password-reset', { token, password });
      setState({ ok: `Your password is changed, ${reply.username}. You were signed out everywhere; sign in with the new password.` });
    } catch (err) { setState({ error: errorText(err) }); }
    setBusy(false);
  }
  const title = kind === 'verify' ? 'Confirm your email' : kind === 'reset' ? 'Choose a new password' : 'Welcome';
  const asksPassword = !state.ok && (kind === 'reset' || (kind === 'invite' && username));
  return (
    <Container size="1" p={{ initial: '3', sm: '6' }} pt={{ initial: '5', sm: '6' }}>
      <Card size={{ initial: '2', sm: '3' }}>
        <form onSubmit={submit} autoComplete="off">
          <Flex direction="column" gap="3">
            <Heading>{title}</Heading>
            {kind === 'invite' && username && !state.ok && <Text color="gray">Your username is <strong>{username}</strong>. Choose a password to finish setting up your account.</Text>}
            {asksPassword && (
              <>
                <Field label={`New password (at least ${PASSWORD_MIN} characters)`}>
                  <TextField.Root type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
                </Field>
                <Field label="New password again">
                  <TextField.Root type="password" value={again} onChange={(event) => setAgain(event.target.value)} required autoComplete="new-password" />
                </Field>
                <Button type="submit" loading={busy}>{kind === 'invite' ? 'Save and sign in' : 'Save new password'}</Button>
                {kind === 'invite' && sso.length > 0 && (
                  <>
                    <Text size="2" color="gray">Or skip the password and sign in with your work account:</Text>
                    {sso.map((provider) => (
                      <Button key={provider.id} type="button" variant="soft" disabled={busy}
                        onClick={() => startSso('/api/sso/start', { provider: provider.id, invite: token }).catch((err) => setState({ error: errorText(err) }))}>
                        Accept with {provider.name}
                      </Button>
                    ))}
                  </>
                )}
              </>
            )}
            {busy && kind !== 'reset' && !username && <Text color="gray">Checking the link…</Text>}
            {state.ok && <Callout.Root color="green"><Callout.Text>{state.ok}</Callout.Text></Callout.Root>}
            {state.error && <Callout.Root color="red"><Callout.Text>{state.error}</Callout.Text></Callout.Root>}
            {(state.ok || state.error) && <Flex><Button type="button" variant="soft" onClick={onDone}>Continue</Button></Flex>}
          </Flex>
        </form>
      </Card>
    </Container>
  );
}

interface ForgotPasswordProps {
  onBack: () => void;
}

/**
 * "Forgot your password?": sends a reset link to the account's confirmed email. The reply never says whether the
 * account exists.
 *
 * @param props - Component props.
 * @param props.onBack - On back.
 * @returns Rendered React element.
 */
export function ForgotPassword({ onBack }: ForgotPasswordProps) {
  const [id, setId] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try { setInfo((await api<{ message: string }>('POST', '/api/password-reset/request', { identifier: id })).message); } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} autoComplete="off">
      <Flex direction="column" gap="3">
        <Text color="gray">Enter your username or confirmed email. We'll email you a link to choose a new password.</Text>
        <TextField.Root value={id} onChange={(event) => setId(event.target.value)} required placeholder="Username or email" />
        <Flex gap="3"><Button type="submit" loading={busy}>Send reset link</Button><Button type="button" variant="soft" color="gray" onClick={onBack}>Back to sign in</Button></Flex>
        {info && <Callout.Root><Callout.Text>{info}</Callout.Text></Callout.Root>}
      </Flex>
    </form>
  );
}

interface FirstSetupProps {
  onDone: () => void;
}

/**
 * First start: no account exists yet. The first account becomes admin of every gate already on this server.
 *
 * @param props - Component props.
 * @param props.onDone - Callback invoked when the action completes.
 * @returns Rendered React element.
 */
export function FirstSetup({ onDone }: FirstSetupProps) {
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError('');
    try { await api('POST', '/api/setup', { setupCode, username, password, email }); onDone(); } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }
  return (
    <Container size="1" p={{ initial: '3', sm: '6' }} pt={{ initial: '5', sm: '6' }}>
      <Card size={{ initial: '2', sm: '3' }}>
        <form onSubmit={submit} autoComplete="off">
          <Flex direction="column" gap="3">
            <Heading>Create the first account</Heading>
            <Text color="gray">
              No account exists on this server yet. This first account becomes the admin of every gate already here. After that,
              gate admins create accounts for the people who use their gates.
            </Text>
            <Field label="Setup code (printed in the server's log when it starts)">
              <TextField.Root value={setupCode} onChange={(event) => setSetupCode(event.target.value)} required autoComplete="off" />
            </Field>
            <Field label="Username"><TextField.Root value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="username" /></Field>
            <Field label="Email (optional)"><TextField.Root type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
            <Field label={`Password (at least ${PASSWORD_MIN} characters)`}>
              <TextField.Root type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
            </Field>
            <Field label="Password again">
              <TextField.Root type="password" value={again} onChange={(event) => setAgain(event.target.value)} required autoComplete="new-password" />
            </Field>
            <Button type="submit" loading={busy}>Create account</Button>
            {error && <Callout.Root color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
          </Flex>
        </form>
      </Card>
    </Container>
  );
}
interface ForcedPasswordChangeProps {
  user: string;
  onDone: () => void;
}

/**
 * After a gate admin (or the server's operator) set this account's password: the user picks their own first.
 *
 * @param props - Component props.
 * @param props.user - Local account username (or actor name for audit logs).
 * @param props.onDone - Callback invoked when the action completes.
 * @returns Rendered React element.
 */
export function ForcedPasswordChange({ user, onDone }: ForcedPasswordChangeProps) {
  const signOut = async () => { await api('DELETE', '/api/session').catch(() => {}); onDone(); };
  return (
    <Container size="1" p={{ initial: '3', sm: '6' }} pt={{ initial: '5', sm: '6' }}>
      <Card size={{ initial: '2', sm: '3' }}>
        <Flex direction="column" gap="3">
          <Heading>Choose your password</Heading>
          <Text color="gray">
            Signed in as <strong>{user}</strong> with a password someone else set. Choose your own to continue. Nobody else can see or change it.
          </Text>
          <PasswordForm submitLabel="Save my password" onChanged={onDone} />
          <Flex><Button variant="ghost" color="gray" onClick={signOut}>Sign out</Button></Flex>
        </Flex>
      </Card>
    </Container>
  );
}
