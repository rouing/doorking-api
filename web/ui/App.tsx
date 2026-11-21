import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Callout, Flex, IconButton, Spinner, Theme } from '@radix-ui/themes';
import type { SessionReply } from '../../src/types.ts';
import { api, errorText, lsGet, lsSet, onSignedOut } from './api.ts';
import { StepUpDialog } from './account/Passkeys.tsx';
import { EmailLink, FirstSetup, ForcedPasswordChange } from './account/SignInPages.tsx';
import { Login } from './Login.tsx';
import { Gates } from './Gates.tsx';
import { GateApp } from './GateApp.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';

export type SignedIn = Extract<SessionReply, { loggedIn: true }>;

// First-account setup, sign-in, a forced password change, then the gate list, then the open gate. The open gate is
// kept in the server session, so a reload opens the same gate. Dark mode is an account setting; this browser
// remembers the last one for the sign-in page.
// An email link in the address (#verify=, #reset=, #invite=), read once when the page opens.
function linkInAddress(): { kind: 'verify' | 'reset' | 'invite'; token: string } | null {
  const match = /^#(verify|reset|invite)=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return match ? { kind: match[1] as 'verify' | 'reset' | 'invite', token: match[2] } : null;
}

// The result of a single sign-on redirect in the address (#sso=linked, #sso-error=<message>), read once and removed.
function ssoInAddress(): { ok: boolean; text: string } | null {
  const match = /^#sso(-error)?=(.*)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname);
  let text = match[2];
  try { text = decodeURIComponent(match[2]); } catch { /* shown as it is */ }
  return match[1] ? { ok: false, text } : { ok: true, text: 'The sign-in was linked to your account.' };
}

export function App() {
  const [link, setLink] = useState(linkInAddress);
  const [ssoNotice, setSsoNotice] = useState(ssoInAddress);
  const [session, setSession] = useState<SessionReply | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const reply = await api<SessionReply>('GET', '/api/session');
      if (reply.loggedIn) lsSet('dk-theme', reply.dark);
      setSession(reply);
      setError('');
    } catch (err) { setError(errorText(err)); }
  }, []);

  useEffect(() => {
    onSignedOut(() => { reload(); });
    reload();
  }, [reload]);

  const dark = session && session.loggedIn ? session.dark : lsGet('dk-theme', false);

  const linkDone = () => { window.history.replaceState(null, '', window.location.pathname); setLink(null); reload(); };

  const renderPage = (): ReactNode => {
    if (link) return <EmailLink kind={link.kind} sso={session ? session.sso : []} token={link.token} onDone={linkDone} />;
    if (error && !session) return <Callout.Root color="red" m="6"><Callout.Text>Server not reachable: {error}</Callout.Text></Callout.Root>;
    if (!session) return <Flex justify="center" p="9"><Spinner size="3" /></Flex>;
    if (!session.loggedIn) {
      return session.setup ? <FirstSetup onDone={reload} /> : <Login onSignedIn={reload} emailEnabled={session.emailEnabled} sso={session.sso} />;
    }
    if (session.mustChangePassword) return <ForcedPasswordChange user={session.user} onDone={reload} />;
    if (!session.gate) return <Gates session={session} onChange={reload} />;
    return <GateApp key={session.gate.phoneNumber} session={session} gate={session.gate} onChange={reload} />;
  };
  return (
    <Theme appearance={dark ? 'dark' : 'light'} accentColor="blue" radius="medium">
      {ssoNotice && (
        <Callout.Root color={ssoNotice.ok ? 'green' : 'red'} role="alert" m="3">
          <Flex align="center" gap="3">
            <Callout.Text>{ssoNotice.text}</Callout.Text>
            <IconButton size="1" variant="ghost" color="gray" title="Dismiss" onClick={() => setSsoNotice(null)}>✕</IconButton>
          </Flex>
        </Callout.Root>
      )}
      {renderPage()}
      {session && session.loggedIn && <StepUpDialog />}
      <UpdateNotice />
    </Theme>
  );
}
