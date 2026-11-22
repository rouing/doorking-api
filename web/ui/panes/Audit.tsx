/**
 * @module web/ui/panes/Audit
 *
 * Access Hygiene & Audit Dashboard: surfaces dormant credentials, active unknown/unassigned cards (with snapshot
 * shortcuts), high-frequency / possibly leaked entry codes, and gate traffic & cycle volume from `tx_history`.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Flex, Grid, Heading, Link, Select, Table, Tabs, Text } from '@radix-ui/themes';
import type { AccessAuditReply, ResidentRow, TransactionRow } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { fmtTime } from '../format.ts';

interface AuditProps {
  gapi: GateApi;
  residents: ResidentRow[];
  transactions: TransactionRow[];
  onOpenResident: (resident: ResidentRow) => void;
  onOpenSnap: (transaction: TransactionRow) => void;
}

/**
 * Access Hygiene & Insights page (`GET /api/gates/:phone/audit`).
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.residents - Loaded resident/vendor rows for one-click navigation.
 * @param props.transactions - Loaded transaction rows for opening unknown-card snapshots.
 * @param props.onOpenResident - Jumps to a resident/vendor entry.
 * @param props.onOpenSnap - Opens the snapshot viewer for a transaction minute.
 * @returns Rendered React element.
 */
export function Audit({ gapi, residents, transactions, onOpenResident, onOpenSnap }: AuditProps) {
  const [days, setDays] = useState('90');
  const [audit, setAudit] = useState<AccessAuditReply | null>(null);
  const [info, setInfo] = useState('Loading…');

  const load = useCallback(async () => {
    setInfo('Loading…');
    try {
      const reply = await gapi<AccessAuditReply>('GET', `/audit?days=${days}`);
      setAudit(reply);
      setInfo('');
    } catch (err) { setInfo(errorText(err)); }
  }, [gapi, days]);
  useEffect(() => { load(); }, [load]);

  const byCode = new Map(residents.map((res) => [res.directoryCode, res]));
  const openByCode = (code: string) => { const found = byCode.get(code); if (found) onOpenResident(found); };
  const openMinuteSnap = (minute: string, cardNumber: string) => {
    const match = transactions.find((tx) => tx.minute === minute && tx.number === cardNumber)
      || transactions.find((tx) => tx.minute === minute);
    if (match) onOpenSnap(match);
  };

  const maxHour = audit ? Math.max(1, ...audit.traffic.byHour) : 1;

  return (
    <Flex direction="column" gap="3">
      <Heading>Access Insights</Heading>
      <Flex gap="3" align="center" wrap="wrap">
        <Select.Root value={days} onValueChange={setDays}>
          <Select.Trigger />
          <Select.Content>
            {[['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', 'Last 180 days'], ['365', 'Last 365 days']].map(([val, label]) => (
              <Select.Item key={val} value={val}>{label}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Button variant="soft" color="gray" onClick={load}>Refresh</Button>
        {info && <Text size="2" color="gray">{info}</Text>}
      </Flex>

      {audit && (
        <>
          <Grid columns={{ initial: '2', sm: '4' }} gap="3">
            <Card>
              <Text size="1" color="gray">Dormant credentials</Text>
              <Heading size="6">{audit.dormant.length}</Heading>
              <Text size="1" color="gray">Unused in {audit.days}d</Text>
            </Card>
            <Card>
              <Text size="1" color="gray">Unknown cards</Text>
              <Heading size="6" color={audit.unknownCards.length ? 'amber' : undefined}>{audit.unknownCards.length}</Heading>
              <Text size="1" color="gray">Unassigned in working copy</Text>
            </Card>
            <Card>
              <Text size="1" color="gray">Flagged entry codes</Text>
              <Heading size="6" color={audit.entryCodes.some((c) => c.flagged) ? 'red' : undefined}>
                {audit.entryCodes.filter((c) => c.flagged).length}
              </Heading>
              <Text size="1" color="gray">High-frequency / off-hours</Text>
            </Card>
            <Card>
              <Text size="1" color="gray">Gate open cycles</Text>
              <Heading size="6">{audit.traffic.openCycles.toLocaleString()}</Heading>
              <Text size="1" color="gray">{audit.traffic.admits} admits · {audit.traffic.denies} denies</Text>
            </Card>
          </Grid>

          <Tabs.Root defaultValue="dormant">
            <Tabs.List>
              <Tabs.Trigger value="dormant">Dormant ({audit.dormant.length})</Tabs.Trigger>
              <Tabs.Trigger value="unknown">Unknown cards ({audit.unknownCards.length})</Tabs.Trigger>
              <Tabs.Trigger value="codes">Entry codes ({audit.entryCodes.length})</Tabs.Trigger>
              <Tabs.Trigger value="traffic">Traffic</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="dormant" style={{ paddingTop: 12 }}>
              <Card>
                <Text size="2" color="gray" as="p" mb="2">
                  Active residents and vendors with cards or an entry code who have had zero recorded events in the last {audit.days} days.
                </Text>
                {audit.dormant.length === 0 ? <Text size="2" color="gray">No dormant credentials found.</Text> : (
                  <Table.Root size="1">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Code</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Entry code</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Cards</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Last seen</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {audit.dormant.map((entry) => (
                        <Table.Row key={entry.directoryCode}>
                          <Table.Cell>{entry.directoryCode}</Table.Cell>
                          <Table.Cell>
                            <Link href="#" onClick={(event) => { event.preventDefault(); openByCode(entry.directoryCode); }}>{entry.name}</Link>
                          </Table.Cell>
                          <Table.Cell>{entry.type}</Table.Cell>
                          <Table.Cell>{entry.entryCode || '—'}</Table.Cell>
                          <Table.Cell>{entry.cards.join(', ') || '—'}</Table.Cell>
                          <Table.Cell>{entry.lastSeen ? fmtTime(entry.lastSeen) : 'Never'}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                )}
              </Card>
            </Tabs.Content>

            <Tabs.Content value="unknown" style={{ paddingTop: 12 }}>
              <Card>
                <Text size="2" color="gray" as="p" mb="2">
                  Card numbers seen in transaction history during the last {audit.days} days that are not assigned to any resident in the working copy.
                </Text>
                {audit.unknownCards.length === 0 ? <Text size="2" color="gray">No unknown cards seen.</Text> : (
                  <Table.Root size="1">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Card</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Uses</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Admits / Denies</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Last seen</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Camera</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {audit.unknownCards.map((card) => (
                        <Table.Row key={card.cardNumber}>
                          <Table.Cell><Text weight="medium">{card.cardNumber}</Text></Table.Cell>
                          <Table.Cell>{card.uses}</Table.Cell>
                          <Table.Cell>{card.admits} / {card.denies}</Table.Cell>
                          <Table.Cell>{fmtTime(card.lastSeen)}</Table.Cell>
                          <Table.Cell>
                            {card.hasSnapshot
                              ? <Button size="1" variant="soft" onClick={() => openMinuteSnap(card.lastMinute, card.cardNumber)}>View snapshot</Button>
                              : <Text size="1" color="gray">—</Text>}
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                )}
              </Card>
            </Tabs.Content>

            <Tabs.Content value="codes" style={{ paddingTop: 12 }}>
              <Card>
                <Text size="2" color="gray" as="p" mb="2">
                  Admitted entry codes ranked by usage in the last {audit.days} days. High-frequency or heavy off-hours codes are flagged as potential leaks.
                </Text>
                {audit.entryCodes.length === 0 ? <Text size="2" color="gray">No admitted entry-code uses in this period.</Text> : (
                  <Table.Root size="1">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeaderCell>Entry code</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Owner</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Uses</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Active days</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Off-hours (11p–5a)</Table.ColumnHeaderCell>
                        <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {audit.entryCodes.map((entry) => (
                        <Table.Row key={entry.entryCode}>
                          <Table.Cell><Text weight="medium">{entry.entryCode}</Text></Table.Cell>
                          <Table.Cell>
                            {entry.directoryCode
                              ? <Link href="#" onClick={(event) => { event.preventDefault(); openByCode(entry.directoryCode); }}>{entry.name || entry.directoryCode} ({entry.directoryCode})</Link>
                              : <Text color="gray">Unassigned</Text>}
                          </Table.Cell>
                          <Table.Cell>{entry.uses}</Table.Cell>
                          <Table.Cell>{entry.distinctDays}</Table.Cell>
                          <Table.Cell>{entry.offHoursUses}</Table.Cell>
                          <Table.Cell>{entry.flagged ? <Badge color="red">High usage</Badge> : <Badge color="gray">Normal</Badge>}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                )}
              </Card>
            </Tabs.Content>

            <Tabs.Content value="traffic" style={{ paddingTop: 12 }}>
              <Flex direction="column" gap="3">
                <Card>
                  <Heading size="3" mb="2">Activity by hour of day ({audit.days} days)</Heading>
                  <Flex align="end" gap="1" style={{ height: 120, paddingTop: 8 }}>
                    {audit.traffic.byHour.map((count, hour) => (
                      <Flex key={hour} direction="column" align="center" style={{ flex: 1, height: '100%', justifyContent: 'flex-end' }}
                        title={`${hour}:00 — ${count} events`}>
                        <div style={{
                          width: '100%',
                          height: `${Math.max(2, Math.round((count / maxHour) * 90))}px`,
                          background: 'var(--accent-9)',
                          borderRadius: '2px 2px 0 0',
                        }} />
                        <Text size="1" color="gray" style={{ fontSize: 10 }}>{hour % 3 === 0 ? hour : ''}</Text>
                      </Flex>
                    ))}
                  </Flex>
                </Card>
                {audit.traffic.byDay.length > 0 && (
                  <Card>
                    <Heading size="3" mb="2">Recent daily volume (last 30 days)</Heading>
                    <Table.Root size="1">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeaderCell>Date</Table.ColumnHeaderCell>
                          <Table.ColumnHeaderCell>Admits</Table.ColumnHeaderCell>
                          <Table.ColumnHeaderCell>Denies</Table.ColumnHeaderCell>
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {[...audit.traffic.byDay].reverse().map((day) => (
                          <Table.Row key={day.date}>
                            <Table.Cell>{day.date}</Table.Cell>
                            <Table.Cell>{day.admits}</Table.Cell>
                            <Table.Cell>{day.denies}</Table.Cell>
                          </Table.Row>
                        ))}
                      </Table.Body>
                    </Table.Root>
                  </Card>
                )}
              </Flex>
            </Tabs.Content>
          </Tabs.Root>
        </>
      )}
    </Flex>
  );
}
