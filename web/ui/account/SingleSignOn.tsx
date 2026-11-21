// Single sign-on: starting a provider sign-in and the account's linked sign-ins.
import { useEffect, useState } from 'react';
import { Button, Card, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { SsoIdentityInfo } from '../../../src/types.ts';
import { api, errorText } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import type { SignedIn } from '../App.tsx';
import { Field } from '../panes/fields.tsx';

// Starts a single sign-on: asks the server for the provider's address (path: /api/sso/start, or /api/me/sso/start to
// link), then opens it. The provider sends the browser back to the app.
export async function startSso(path: string, body: Record<string, unknown>): Promise<void> {
  const { url } = await api<{ url: string }>('POST', path, body);
  window.location.assign(url);
}
// The account's single sign-on: linked provider accounts (unlink) and Link buttons (the current password first, when the
// account has one; the provider then sends the browser back here).
export function SingleSignOn({ session }: { session: SignedIn }) {
  const [list, setList] = useState<SsoIdentityInfo[]>([]);
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  useEffect(() => { api<{ identities: SsoIdentityInfo[] }>('GET', '/api/me/sso').then((r) => setList(r.identities), (err) => setInfo(errorText(err))); }, []);
  if (!session.sso.length && !list.length) return null;
  const linkTo = (provider: string) => {
    setInfo('Opening the sign-in page…');
    startSso('/api/me/sso/start', { provider, password }).catch((err) => setInfo(errorText(err)));
  };
  const unlink = async (i: SsoIdentityInfo) => {
    if (!await confirm({ title: `Unlink ${i.providerName}${i.email ? ` (${i.email})` : ''}?`, action: 'Unlink', color: 'red',
      body: 'It will no longer sign you in to this account.' })) return;
    try {
      setList((await api<{ identities: SsoIdentityInfo[] }>('DELETE', `/api/me/sso/${encodeURIComponent(i.provider)}/${encodeURIComponent(i.subject)}`)).identities);
      setInfo(`Unlinked ${i.providerName}.`);
    } catch (err) { setInfo(errorText(err)); }
  };
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Single sign-on</Heading>
        <Text size="2" color="gray">Sign in with your work account instead of a password. Link it here once; then use its button on the sign-in page.</Text>
        {list.length > 0 && (
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>{['Account', 'Email', 'Linked', 'Last used', ''].map((h, i) => <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
            </Table.Header>
            <Table.Body>
              {list.map((i) => (
                <Table.Row key={`${i.provider}/${i.subject}`} align="center">
                  <Table.Cell>{i.providerName}</Table.Cell>
                  <Table.Cell>{i.email || '—'}</Table.Cell>
                  <Table.Cell>{fmtTime(i.linkedAt)}</Table.Cell>
                  <Table.Cell>{i.lastUsedAt ? fmtTime(i.lastUsedAt) : 'never'}</Table.Cell>
                  <Table.Cell><Button size="1" variant="soft" color="red" onClick={() => unlink(i)}>Unlink</Button></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
        {session.sso.length > 0 && (
          <Flex gap="3" align="end" wrap="wrap">
            {session.hasPassword && <Field label="Your current password"><TextField.Root type="password" value={password} autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)} /></Field>}
            {session.sso.map((provider) => <Button key={provider.id} variant="soft" onClick={() => linkTo(provider.id)}>Link {provider.name}</Button>)}
          </Flex>
        )}
        {info && <Text size="2" color="gray">{info}</Text>}
      </Flex>
    </Card>
  );
}
