/**
 * @module web/ui/settings/Webhooks
 *
 * System Settings card for managing per-gate outbound webhooks, testing delivery, and viewing recent delivery results.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Badge, Button, Callout, Card, Checkbox, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { WebhookDelivery, WebhookEvent, WebhookInfo } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';

interface WebhooksCardProps {
  gapi: GateApi;
}

const DEFAULT_EVENTS: WebhookEvent[] = ['send.completed', 'send.failed', 'relay.changed', 'pull.completed'];

/**
 * Outbound Webhooks management card (admin-only, under System Settings).
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @returns Rendered React element.
 */
export function WebhooksCard({ gapi }: WebhooksCardProps) {
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [available, setAvailable] = useState<WebhookEvent[]>(DEFAULT_EVENTS);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(DEFAULT_EVENTS);
  const [newSecret, setNewSecret] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const reply = await gapi<{ webhooks: WebhookInfo[]; deliveries: WebhookDelivery[]; availableEvents: WebhookEvent[] }>('GET', '/webhooks');
      setWebhooks(reply.webhooks);
      setDeliveries(reply.deliveries);
      setAvailable(reply.availableEvents);
    } catch (err) { setInfo(errorText(err)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  const toggleEvent = (event: WebhookEvent) => {
    setEvents((cur) => (cur.includes(event) ? cur.filter((e) => e !== event) : [...cur, event]));
  };

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setInfo('');
    setNewSecret('');
    try {
      const reply = await gapi<{ webhook: WebhookInfo; secret: string }>('POST', '/webhooks', { name, url, events });
      setNewSecret(reply.secret);
      setName('');
      setUrl('');
      await load();
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }

  async function toggleEnabled(hook: WebhookInfo) {
    setBusy(true);
    try {
      await gapi('PUT', `/webhooks/${encodeURIComponent(hook.id)}`, { enabled: !hook.enabled });
      await load();
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }

  async function testHook(hook: WebhookInfo) {
    setBusy(true);
    setInfo(`Testing "${hook.name}"…`);
    try {
      const res = await gapi<{ ok: boolean; status: number; error?: string }>('POST', `/webhooks/${encodeURIComponent(hook.id)}/test`, {});
      setInfo(`Test "${hook.name}": HTTP ${res.status} OK`);
    } catch (err) { setInfo(`Test "${hook.name}" failed: ${errorText(err)}`); }
    setBusy(false);
  }

  async function remove(hook: WebhookInfo) {
    if (!await confirm({ title: `Delete webhook "${hook.name}"?`, action: 'Delete', color: 'red',
      body: 'Stops sending events to this URL and deletes its delivery log.' })) return;
    setBusy(true);
    try {
      await gapi('DELETE', `/webhooks/${encodeURIComponent(hook.id)}`);
      await load();
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }

  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Outbound webhooks</Heading>
        <Text size="2" color="gray">
          Send HMAC-SHA256 signed JSON notifications (<code>X-DoorKing-Signature</code>) to Slack, Home Assistant, or
          your own HTTPS endpoint when pulls, sends, or live relay changes happen.
        </Text>
        {newSecret && (
          <Callout.Root color="green">
            <Callout.Text>
              Webhook signing secret (shown once — copy it now): <code>{newSecret}</code>
            </Callout.Text>
          </Callout.Root>
        )}
        {info && <Text size="2" color="gray">{info}</Text>}
        {webhooks.length > 0 && (
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>URL</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Events</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {webhooks.map((hook) => (
                <Table.Row key={hook.id}>
                  <Table.Cell>{hook.name}</Table.Cell>
                  <Table.Cell><Text size="1" style={{ wordBreak: 'break-all' }}>{hook.url}</Text></Table.Cell>
                  <Table.Cell><Text size="1">{hook.events.join(', ')}</Text></Table.Cell>
                  <Table.Cell><Badge color={hook.enabled ? 'green' : 'gray'}>{hook.enabled ? 'On' : 'Off'}</Badge></Table.Cell>
                  <Table.Cell>
                    <Flex gap="2" wrap="wrap">
                      <Button size="1" variant="soft" disabled={busy} onClick={() => testHook(hook)}>Test</Button>
                      <Button size="1" variant="soft" color="gray" disabled={busy} onClick={() => toggleEnabled(hook)}>{hook.enabled ? 'Pause' : 'Enable'}</Button>
                      <Button size="1" variant="soft" color="red" disabled={busy} onClick={() => remove(hook)}>Delete</Button>
                    </Flex>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
        <form onSubmit={add}>
          <Flex direction="column" gap="2">
            <Flex gap="2" wrap="wrap">
              <TextField.Root placeholder="Name (e.g. Home Assistant)" value={name} onChange={(e) => setName(e.target.value)} required style={{ flex: '1 1 180px' }} />
              <TextField.Root placeholder="https://example.com/webhook" value={url} onChange={(e) => setUrl(e.target.value)} required style={{ flex: '2 1 280px' }} />
              <Button type="submit" disabled={busy || !events.length}>Add webhook</Button>
            </Flex>
            <Flex gap="3" wrap="wrap">
              {available.map((event) => (
                <Text as="label" size="1" key={event}>
                  <Flex align="center" gap="1">
                    <Checkbox checked={events.includes(event)} onCheckedChange={() => toggleEvent(event)} />
                    {event}
                  </Flex>
                </Text>
              ))}
            </Flex>
          </Flex>
        </form>
        {deliveries.length > 0 && (
          <Flex direction="column" gap="1">
            <Text size="2" weight="medium">Recent deliveries</Text>
            <Table.Root size="1">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Time</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Event</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Details</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {deliveries.slice(0, 10).map((d) => (
                  <Table.Row key={d.id}>
                    <Table.Cell>{fmtTime(d.createdAt)}</Table.Cell>
                    <Table.Cell>{d.event}</Table.Cell>
                    <Table.Cell>
                      <Badge color={d.status === 'sent' ? 'green' : d.status === 'failed' ? 'red' : 'amber'}>
                        {d.status}{d.lastStatus ? ` (${d.lastStatus})` : ''}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell><Text size="1" color="gray">{d.lastError || `${d.attempts} try`}</Text></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
