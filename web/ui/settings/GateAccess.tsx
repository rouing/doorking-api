// Who can reach the gate (admins): its DKS login and master code, gate users and API keys.
import { useEffect, useState } from 'react';
import { Badge, Button, Callout, Card, Flex, Grid, Heading, Link, Table, Text, TextField } from '@radix-ui/themes';
import type { ApiKeyInfo, GateLogin, GateRole, GateUser } from '../../../src/types.ts';
import { ApiError, errorText, type GateApi } from '../api.ts';
import { fmtIntlPhone, fmtTime } from '../format.ts';
import { Choice, Field } from '../panes/fields.tsx';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';

// The gate's DKS login and master code (admins). A new DKS login is checked with DKS Cloud before it is saved; a new
// master code is checked by pulling residents with it and saved only when that works. Neither is ever shown.
export function GateLoginCard({ gapi, onJobStarted }: { gapi: GateApi; onJobStarted: () => void }) {
  const [login, setLogin] = useState<GateLogin | null>(null);
  const [f, setF] = useState({ dksUser: '', dksPassword: '', masterCode: '' });
  const [info, setInfo] = useState('');
  const load = () => gapi<GateLogin>('GET', '/login').then((l) => { setLogin(l); setF({ dksUser: l.dksUser, dksPassword: '', masterCode: '' }); },
    (err) => setInfo(errorText(err)));
  useEffect(() => { load(); }, [gapi]);
  const save = async () => {
    setInfo('Checking with DKS Cloud…');
    try {
      const reply = await gapi<{ changed?: boolean; checking?: boolean }>('PUT', '/login', f);
      setInfo(reply.checking ? 'Checking the new master code with a residents pull. It is saved when the pull succeeds (see Gate connection).'
        : reply.changed ? 'DKS login saved.' : 'Nothing changed.');
      if (reply.checking) onJobStarted();
      await load();
    } catch (err) { setInfo(`Not saved: ${errorText(err)}`); }
  };
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Heading size="3">Gate login<HelpTip of="dksLogin" /></Heading>
        <Text size="2" color="gray">
          The DKS Cloud login and master code this gate's pulls, sends, relay changes and scheduled transfers use, for every user of the gate.
          Leave the password and master code empty to keep the saved ones.
        </Text>
        {login && !login.dksPasswordSet && (
          <Callout.Root color="amber"><Callout.Text>No DKS login saved yet: pulls and sends fail until you set one.</Callout.Text></Callout.Root>
        )}
        <Grid columns={{ initial: '1', sm: '3' }} gap="3">
          <Field label="DKS user"><TextField.Root value={f.dksUser} autoComplete="off" onChange={(event) => setF({ ...f, dksUser: event.target.value })} /></Field>
          <Field label="DKS password"><TextField.Root type="password" value={f.dksPassword} autoComplete="new-password"
            placeholder={login && login.dksPasswordSet ? 'saved (leave empty to keep)' : ''} onChange={(event) => setF({ ...f, dksPassword: event.target.value })} /></Field>
          <Field label="Master code" help="gateMasterCode"><TextField.Root type="password" value={f.masterCode} inputMode="numeric" maxLength={4}
            autoComplete="off" placeholder="saved (leave empty to keep)" onChange={(event) => setF({ ...f, masterCode: event.target.value })} /></Field>
        </Grid>
        <Flex gap="3" align="center"><Button onClick={save}>Save gate login</Button><Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </Card>
  );
}

function RoleSelect({ value, onChange }: { value: GateRole; onChange: (role: GateRole) => void }) {
  return (
    <Choice value={value} onChange={(v) => onChange(v as GateRole)} options={[['readonly', 'Read only'], ['admin', 'Admin']]} />
  );
}

// Who may use this gate (admins): roles, removing access, creating an account for the gate, and sharing it with an
// existing account. A gate always keeps at least one admin; nobody can see or set another user's password.
export function GateUsersCard({ gapi, me, emailEnabled, onSessionChange }: { gapi: GateApi; me: string; emailEnabled: boolean; onSessionChange: () => void }) {
  const [users, setUsers] = useState<GateUser[]>([]);
  const [info, setInfo] = useState('');
  const [create, setCreate] = useState({ username: '', password: '', email: '', role: 'readonly' as GateRole });
  const [createInfo, setCreateInfo] = useState('');
  const [exists, setExists] = useState('');
  const [share, setShare] = useState({ username: '', role: 'readonly' as GateRole });
  const [shareInfo, setShareInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const load = () => gapi<{ users: GateUser[] }>('GET', '/users').then((r) => setUsers(r.users), (err) => setInfo(errorText(err)));
  useEffect(() => { load(); }, [gapi]);
  const act = async (fn: () => Promise<{ users: GateUser[] }>, set: (t: string) => void, done: string) => {
    try { setUsers((await fn()).users); set(done); return true; } catch (err) { set(errorText(err)); return false; }
  };
  const changeRole = async (user: GateUser, role: GateRole) => {
    await act(() => gapi('PUT', `/users/${encodeURIComponent(user.username)}`, { role }), setInfo, `${user.username} is now ${role === 'admin' ? 'an admin' : 'read only'}.`);
    if (user.username === me) onSessionChange();
  };
  const remove = async (user: GateUser) => {
    if (!await confirm({ title: `Remove ${user.username} from this gate?`, action: 'Remove', color: 'red',
      body: 'They will no longer see this gate. Their account stays (it may have other gates).' })) return;
    await act(() => gapi('DELETE', `/users/${encodeURIComponent(user.username)}`), setInfo, `${user.username} removed.`);
    if (user.username === me) onSessionChange();
  };
  const createUser = async () => {
    setExists('');
    try {
      const reply = await gapi<{ users: GateUser[]; invited: boolean }>('POST', '/users', create);
      setUsers(reply.users);
      const who = create.username.trim().toLowerCase();
      setCreateInfo(reply.invited ? `Invitation sent to ${create.email.trim()}. ${who} chooses their password with the link (valid 72 hours).`
        : `Account ${who} created. Give them the username and temporary password; they choose their own at their first sign-in.`);
      setCreate({ username: '', password: '', email: '', role: 'readonly' });
    } catch (err) {
      setCreateInfo(errorText(err));
      if (err instanceof ApiError && err.body.exists) setExists(create.username.trim().toLowerCase());
      if (err instanceof ApiError && Array.isArray(err.body.users)) setUsers(err.body.users as GateUser[]); // created, but the email failed
    }
  };
  const resendInvite = (user: GateUser) => act(() => gapi('POST', `/users/${encodeURIComponent(user.username)}/invite`, {}), setInfo,
    `Invitation sent again to ${user.pendingEmail}.`);
  const shareWith = (username: string, role: GateRole, set: (t: string) => void) =>
    act(() => gapi('POST', '/share', { username, role }), set, `Shared with ${username.trim().toLowerCase()}.`);
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Gate users<HelpTip of="gateRole" /></Heading>
        <Text size="2" color="gray">
          Everyone who can open this gate. <strong>Admin</strong>: can change everything, including this list. <strong>Read only</strong>: can look,
          pull and use the cameras. A gate always keeps at least one admin.
        </Text>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>{['User', 'Email', 'Phone', 'Role', 'Added by', 'Last sign-in', ''].map((h, i) => <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
          </Table.Header>
          <Table.Body>
            {users.map((user) => (
              <Table.Row key={user.username} align="center">
                <Table.Cell>{user.username}{user.username === me && <Badge ml="2" color="gray">you</Badge>}</Table.Cell>
                <Table.Cell>
                  {user.email || (user.pendingEmail ? <Text color="gray">{user.pendingEmail} (unconfirmed)</Text> : '')}
                  {user.invited && <Flex gap="2" align="center" mt="1"><Badge color="amber">invited</Badge>
                    {emailEnabled && <Button size="1" variant="ghost" onClick={() => resendInvite(user)}>Send again</Button>}</Flex>}
                </Table.Cell>
                <Table.Cell>{user.phone ? <a href={`tel:${user.phone}`}>{fmtIntlPhone(user.phone)}</a> : ''}</Table.Cell>
                <Table.Cell><RoleSelect value={user.role} onChange={(role) => changeRole(user, role)} /></Table.Cell>
                <Table.Cell>{user.grantedBy}</Table.Cell>
                <Table.Cell>{user.lastSignIn ? fmtTime(user.lastSignIn) : 'never'}</Table.Cell>
                <Table.Cell><Button size="1" variant="soft" color="red" onClick={() => remove(user)}>Remove</Button></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        {info && <Text size="2" color="gray">{info}</Text>}
        <Heading size="2">Create an account for this gate</Heading>
        <Text size="2" color="gray">
          {emailEnabled ? 'With an email and no password, they get an invitation link to choose their own password. Without an email, set a temporary password; they choose their own at their first sign-in.'
            : 'Set a temporary password; they choose their own at their first sign-in. (Email invitations need email set up on the server.)'}
        </Text>
        <Grid columns={{ initial: '1', sm: '4' }} gap="3">
          <Field label="Username"><TextField.Root value={create.username} autoComplete="off" onChange={(event) => setCreate({ ...create, username: event.target.value })} /></Field>
          <Field label={emailEnabled ? "Temporary password (only without an invitation)" : "Temporary password (12+ characters)"}><TextField.Root type="password" value={create.password} autoComplete="new-password"
            onChange={(event) => setCreate({ ...create, password: event.target.value })} /></Field>
          <Field label={emailEnabled ? "Email (sends an invitation)" : "Email (optional)"}><TextField.Root type="email" value={create.email} onChange={(event) => setCreate({ ...create, email: event.target.value })} /></Field>
          <Field label="Role"><RoleSelect value={create.role} onChange={(role) => setCreate({ ...create, role: role })} /></Field>
        </Grid>
        <Flex gap="3" align="center" wrap="wrap">
          <Button onClick={createUser}>Create account</Button>
          {exists && <Button variant="soft" onClick={async () => { if (await shareWith(exists, create.role, setCreateInfo)) setExists(''); }}>
            Share this gate with {exists} instead</Button>}
          <Text size="2" color="gray">{createInfo}</Text>
        </Flex>
        <Heading size="2">Share with an existing account</Heading>
        <Flex gap="3" align="end" wrap="wrap">
          <Field label="Username"><TextField.Root value={share.username} autoComplete="off" onChange={(event) => setShare({ ...share, username: event.target.value })} /></Field>
          <Field label="Role"><RoleSelect value={share.role} onChange={(role) => setShare({ ...share, role: role })} /></Field>
          <Button onClick={async () => { if (await shareWith(share.username, share.role, setShareInfo)) setShare({ username: '', role: 'readonly' }); }}>Share</Button>
          <Text size="2" color="gray">{shareInfo}</Text>
        </Flex>
      </Flex>
    </Card>
  );
}

// API keys for scripts and other systems (admins). A key belongs to this gate, not to a person; it is shown once when
// created and works only on this gate's routes, with its own role. Revoking stops it at once.
export function ApiKeysCard({ phone, gapi }: { phone: string; gapi: GateApi }) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [form, setForm] = useState({ name: '', role: 'readonly' as GateRole, expiresDays: '0' });
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const load = () => gapi<{ apiKeys: ApiKeyInfo[] }>('GET', '/api-keys').then((r) => setKeys(r.apiKeys), (err) => setInfo(errorText(err)));
  useEffect(() => { load(); }, [gapi]);
  const create = async () => {
    try {
      const reply = await gapi<{ key: string; apiKey: ApiKeyInfo }>('POST', '/api-keys', { ...form, expiresDays: Number(form.expiresDays) });
      setCreated({ key: reply.key, name: reply.apiKey.name });
      setForm({ name: '', role: 'readonly', expiresDays: '0' });
      setInfo('');
      await load();
    } catch (err) { setInfo(errorText(err)); }
  };
  const revoke = async (k: ApiKeyInfo) => {
    if (!await confirm({ title: `Revoke the API key "${k.name}"?`, action: 'Revoke', color: 'red',
      body: 'Anything using it stops working at once. This can\'t be undone; create a new key if needed.' })) return;
    try { setKeys((await gapi<{ apiKeys: ApiKeyInfo[] }>('DELETE', `/api-keys/${encodeURIComponent(k.id)}`)).apiKeys); setInfo(`Revoked "${k.name}".`); } catch (err) { setInfo(errorText(err)); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(created!.key); setInfo('Copied.'); } catch { setInfo('Copy failed: select the key and copy it.'); } };
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">API keys<HelpTip of="apiKeys" /></Heading>
        <Text size="2" color="gray">
          Keys let scripts and other systems use this gate's API without a username or password. A key belongs to the gate (it keeps working if
          the person who made it leaves) and works only on this gate. <strong>Read only</strong> keys can view and pull; <strong>Admin</strong> keys
          can also make changes and send. No key can change the gate login, users, API keys, or delete the gate's data. Send it as the header{' '}
          <code>Authorization: Bearer &lt;key&gt;</code> to <code>/api/gates/{phone}/…</code>.{' '}
          <Link href="/api/docs" target="_blank" rel="noopener">API documentation ↗</Link> (try calls there with a key).
        </Text>
        {created && (
          <Callout.Root color="green">
            <Callout.Text>
              Key "{created.name}" created. <strong>Copy it now: it won't be shown again.</strong>
              <code style={{ display: 'block', margin: '8px 0', wordBreak: 'break-all', userSelect: 'all' }}>{created.key}</code>
              <Flex gap="2"><Button size="1" onClick={copy}>Copy</Button><Button size="1" variant="soft" color="gray" onClick={() => setCreated(null)}>Done</Button></Flex>
            </Callout.Text>
          </Callout.Root>
        )}
        {keys.length > 0 && (
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>{['Name', 'Role', 'Created', 'Expires', 'Last used', ''].map((h, i) => <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
            </Table.Header>
            <Table.Body>
              {keys.map((k) => {
                const expired = Boolean(k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now());
                return (
                  <Table.Row key={k.id} align="center">
                    <Table.Cell>{k.name}</Table.Cell>
                    <Table.Cell>{k.role === 'admin' ? 'Admin' : 'Read only'}</Table.Cell>
                    <Table.Cell>{fmtTime(k.createdAt)} by {k.createdBy}</Table.Cell>
                    <Table.Cell>{k.expiresAt ? <Text color={expired ? 'red' : undefined}>{expired ? 'expired ' : ''}{fmtTime(k.expiresAt)}</Text> : 'never'}</Table.Cell>
                    <Table.Cell>{k.lastUsedAt ? fmtTime(k.lastUsedAt) : 'never'}</Table.Cell>
                    <Table.Cell><Button size="1" variant="soft" color="red" onClick={() => revoke(k)}>Revoke</Button></Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        )}
        <Flex gap="3" align="end" wrap="wrap">
          <Field label="Name"><TextField.Root value={form.name} maxLength={40} placeholder="e.g. Home Assistant" onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="Role"><RoleSelect value={form.role} onChange={(role) => setForm({ ...form, role: role })} /></Field>
          <Field label="Expires">
            <Choice value={form.expiresDays} onChange={(v) => setForm({ ...form, expiresDays: v })}
              options={[['0', 'Never'], ['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In 1 year']]} />
          </Field>
          <Button onClick={create}>Create API key</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
      </Flex>
    </Card>
  );
}
