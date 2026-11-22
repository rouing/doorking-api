import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Callout, Card, Container, Flex, Grid, Heading, Link, Separator, Text, TextField } from '@radix-ui/themes';
import type { GateInfo, Job } from '../../src/types.ts';
import { api, errorText } from './api.ts';
import { useConfirm } from './Confirm.tsx';
import { UserSettings } from './account/UserSettings.tsx';
import { Field } from './panes/fields.tsx';
import { ConfigFields } from './settings/GateConfig.tsx';
import { GATE_CONFIG_KEYS } from '../../src/shared.ts';
import type { SignedIn } from './App.tsx';

/**
 * Gate label.
 *
 * @param gate - Gate summary (`phoneNumber`, `siteName`, `role`).
 * @returns Computed result.
 */
export const gateLabel = (gate: GateInfo) => gate.siteName || `Gate ${gate.phoneNumber}`;
/**
 * Role label.
 *
 * @param role - Gate access role (`admin` or `readonly`).
 * @returns Rendered React element.
 */
export const roleLabel = (role: GateInfo['role']) => (role === 'admin' ? 'Admin' : 'Read only');

interface AddGateProps {
  session: SignedIn;
  onAdded: () => void;
}

/**
 * Adds a gate: its phone, master code, DKS login and gate configuration. The server checks the DKS login, then pulls
 * residents with these values; the gate is added (with this user as its admin) only when that pull succeeds.
 *
 * @param props - Component props.
 * @param props.session - Authenticated user or API-key session.
 * @param props.onAdded - Callback invoked after a gate is added.
 * @returns Rendered React element.
 */
function AddGate({ session, onAdded }: AddGateProps) {
  const [form, setForm] = useState({ phoneNumber: '', masterCode: '', dksUser: '', dksPassword: '' });
  const [cfg, setCfg] = useState<Record<string, string>>(() => Object.fromEntries(GATE_CONFIG_KEYS.map((key) => [key, session.defaults[key] || ''])));
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const set = (key: keyof typeof form, value: string) => setForm({ ...form, [key]: value });

  const mounted = useRef(true);
  const checking = useRef(false); // a gate add was started or seen running: a failed check is tried again
  /**
   * Polls the checking pull every 3 s while it runs. Stops when the form closes (a check still on its way then
   * doesn't start polling again).
   */
  const poll = async () => {
    clearTimeout(timer.current);
    const reply = await api<{ job: Job | null }>('GET', '/api/gate-add').catch(() => undefined);
    if (!mounted.current) return;
    if (reply === undefined) {
      if (checking.current) timer.current = setTimeout(poll, 3000);
      else setBusy(false);
      return;
    }
    const latest = reply.job;
    setJob(latest);
    if (latest && latest.state === 'running') { checking.current = true; timer.current = setTimeout(poll, 3000); return; }
    checking.current = false;
    setBusy(false);
    if (latest && latest.state === 'done') { setForm({ phoneNumber: '', masterCode: '', dksUser: '', dksPassword: '' }); onAdded(); }
  };
  useEffect(() => {
    mounted.current = true;
    poll();
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('POST', '/api/gates', { ...form, gateConfig: cfg });
      setJob(null);
      checking.current = true;
      poll();
    } catch (err) { setError(errorText(err)); setBusy(false); }
  }

  const running = job && job.state === 'running';
  return (
    <form onSubmit={add} autoComplete="off">
      <Flex direction="column" gap="3">
        <Heading size="3">Add a gate</Heading>
        <Text size="2" color="gray">
          Enter the gate's details. The app signs in to DKS Cloud with the gate's DKS login and pulls the residents; only when that works is the
          gate added, with you as its admin. If the gate is already managed here, ask one of its gate admins to add you instead.
        </Text>
        <Grid columns={{ initial: '1', sm: '2' }} gap="3">
          <Field label="System phone" help="systemPhone">
            <TextField.Root value={form.phoneNumber} onChange={(event) => set('phoneNumber', event.target.value)} required inputMode="tel" disabled={busy} />
          </Field>
          <Field label="Master code" help="gateMasterCode">
            <TextField.Root type="password" value={form.masterCode} onChange={(event) => set('masterCode', event.target.value)} required inputMode="numeric"
              maxLength={4} autoComplete="off" disabled={busy} />
          </Field>
          <Field label="DKS user" help="dksLogin">
            <TextField.Root value={form.dksUser} onChange={(event) => set('dksUser', event.target.value)} required autoComplete="off" disabled={busy} />
          </Field>
          <Field label="DKS password" help="dksLogin">
            <TextField.Root type="password" value={form.dksPassword} onChange={(event) => set('dksPassword', event.target.value)} required
              autoComplete="new-password" disabled={busy} />
          </Field>
        </Grid>
        <Text size="2" weight="medium">Gate configuration (must match the gate)</Text>
        <ConfigFields config={cfg} onChange={setCfg} disabled={busy} />
        <Flex gap="3" align="center" wrap="wrap"><Button type="submit" loading={busy}>Add gate</Button></Flex>
        {error && <Callout.Root color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
        {job && (
          <Callout.Root color={running ? 'blue' : job.state === 'done' ? 'green' : 'red'}>
            <Callout.Text>
              {running ? `Checking gate ${job.phoneNumber}: ${job.log.length ? job.log[job.log.length - 1].replace(/^\S+\s+\S+\s+/, '') : 'starting…'}`
                : job.state === 'done' ? `Gate ${job.phoneNumber} added. You are its admin.`
                  : `Gate ${job.phoneNumber} was not added: ${job.error || 'the check failed'}`}
            </Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    </form>
  );
}

interface GatesProps {
  session: SignedIn;
  onChange: () => void;
}

/**
 * The signed-in user's gates (open or leave one), User Settings, and adding a gate.
 *
 * @param props - Component props.
 * @param props.session - Authenticated user or API-key session.
 * @param props.onChange - Callback invoked when the value changes.
 * @returns Rendered React element.
 */
export function Gates({ session, onChange }: GatesProps) {
  const [gates, setGates] = useState<GateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [dialog, confirm] = useConfirm();

  const load = () => api<{ gates: GateInfo[] }>('GET', '/api/gates').then((reply) => setGates(reply.gates), (err) => setError(errorText(err)));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); } catch (err) { setError(errorText(err)); }
  };

  const open = (gate: GateInfo) => run(async () => { await api('PUT', '/api/session/gate', { phoneNumber: gate.phoneNumber }); onChange(); });

  const leave = async (gate: GateInfo) => {
    if (!await confirm({ title: `Leave ${gateLabel(gate)}?`, action: 'Leave', color: 'red',
      body: 'You will no longer see this gate. Its data stays for its other users. A gate admin can add you again.' })) return;
    await run(() => api('DELETE', `/api/gates/${encodeURIComponent(gate.phoneNumber)}`));
    load();
  };

  const signOut = () => run(async () => { await api('DELETE', '/api/session'); onChange(); });

  return (
    <Container size="3" p={{ initial: '3', sm: '6' }} pt={{ initial: '5', sm: '6' }}>
      {dialog}
      <Card size={{ initial: '2', sm: '3' }}>
        <Flex align="center" gap="3" mb="4" wrap="wrap">
          <Heading>{settings ? 'User Settings' : 'Your gates'}</Heading>
          <Text color="gray">{session.user}</Text>
          <Flex flexGrow="1" />
          <Link href="/help" target="_blank" rel="noopener" size="2">Help</Link>
          <Button variant="soft" color="gray" onClick={() => setSettings(!settings)}>{settings ? 'Back to gates' : 'User settings'}</Button>
          <Button variant="soft" color="gray" onClick={signOut}>Sign out</Button>
        </Flex>
        {settings ? <UserSettings session={session} onSaved={onChange} /> : (
          <>
            {gates && !gates.length && <Text color="gray">No gates yet. Add one below, or ask a gate admin to add you to theirs.</Text>}
            <Flex direction="column" gap="2">
              {(gates || []).map((gate) => (
                <Flex key={gate.phoneNumber} align="center" gap="3" wrap="wrap">
                  <Flex direction="column" flexGrow="1" minWidth="10rem">
                    <Text weight="medium">{gateLabel(gate)}</Text>
                    <Text size="1" color="gray">{gate.phoneNumber}</Text>
                  </Flex>
                  <Badge color={gate.role === 'admin' ? 'blue' : 'gray'}>{roleLabel(gate.role)}</Badge>
                  <Button onClick={() => open(gate)}>Open</Button>
                  <Button variant="soft" color="gray" onClick={() => leave(gate)}>Leave</Button>
                </Flex>
              ))}
            </Flex>
            {error && <Callout.Root color="red" mt="3"><Callout.Text>{error}</Callout.Text></Callout.Root>}
            <Separator size="4" my="4" />
            <AddGate session={session} onAdded={load} />
          </>
        )}
      </Card>
    </Container>
  );
}
