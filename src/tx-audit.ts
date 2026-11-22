/**
 * @module src/tx-audit
 *
 * Access hygiene and operational analytics over `tx_history`, `gate_residents`, `gate_cards`, and `snapshots`:
 * dormant credentials, active unassigned/unknown cards, high-frequency/possibly leaked entry codes, and traffic stats.
 */
import { decodeRcvEvent, hasValidDate } from './board-files.ts';
import { minuteKey, listSnapshots } from './camera-log.ts';
import { loadWorkingState } from './gate-state.ts';
import { readTransactionPage } from './tx-history.ts';
import type { Store } from './db.ts';
import type { AccessAuditReply, DormantEntry, EntryCodeUsage, UnknownCardActivity } from './types.ts';

const DAY_MS = 86400000;

/**
 * Builds the access hygiene and traffic audit report for a gate over the trailing `days` window.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param [options] - Audit parameters.
 * @param [options.days] - Look-back window in days (30–730, default 90).
 * @param [options.now] - Reference timestamp in milliseconds (defaults to `Date.now()`).
 * @returns Promise resolving to `AccessAuditReply`.
 */
export async function buildAccessAudit(
  store: Store,
  phone: string,
  { days = 90, now = Date.now() }: { days?: number; now?: number } = {},
): Promise<AccessAuditReply> {
  const [{ records }, working, snapshots] = await Promise.all([
    readTransactionPage(store, phone),
    loadWorkingState(store, phone),
    listSnapshots(store, phone),
  ]);

  const residents = working?.state.residents || [];
  const cards = working?.state.cards || [];
  const cardsByCode = new Map<string, string[]>();
  const ownerByCard = new Map<string, string>();
  for (const card of cards) {
    if (!card.directoryCode) continue;
    ownerByCard.set(card.cardNumber, card.directoryCode);
    const list = cardsByCode.get(card.directoryCode) || [];
    list.push(card.cardNumber);
    cardsByCode.set(card.directoryCode, list);
  }
  const residentByCode = new Map(residents.map((res) => [res.directoryCode, res]));
  const ownerByEntry = new Map<string, string>();
  for (const res of residents) {
    if (res.entryCode) ownerByEntry.set(res.entryCode, res.directoryCode);
  }

  const cutoff = now - days * DAY_MS;
  const trafficCutoff = now - 30 * DAY_MS;
  const residentLastSeen = new Map<string, { lastSeen: number; totalEvents: number }>();
  const unknownCards = new Map<string, { uses: number; admits: number; denies: number; lastSeen: number; lastMinute: string }>();
  const entryStats = new Map<string, { uses: number; days: Set<string>; offHours: number; lastSeen: number }>();
  const byHour = Array.from({ length: 24 }, () => 0);
  const byDayMap = new Map<string, { admits: number; denies: number }>();
  let totalEvents = 0;
  let admits = 0;
  let denies = 0;
  let holds = 0;
  let openCycles = 0;

  for (const rec of records) {
    if (!hasValidDate(rec) || !rec.year) continue;
    const hour24 = (rec.hour % 12) + (rec.pm ? 12 : 0);
    const ts = new Date(rec.year, rec.month - 1, rec.day, hour24, rec.minute).getTime();
    const dateKey = `${rec.year}-${String(rec.month).padStart(2, '0')}-${String(rec.day).padStart(2, '0')}`;
    const event = decodeRcvEvent(rec);

    let dirCode = '';
    if (event.lookup === 'directory' && event.number) dirCode = event.number;
    else if (event.lookup === 'entryCode' && event.number) dirCode = ownerByEntry.get(event.number) || '';
    else if (event.lookup === 'card' && event.number) dirCode = ownerByCard.get(event.number) || '';

    if (dirCode) {
      const prev = residentLastSeen.get(dirCode);
      residentLastSeen.set(dirCode, {
        lastSeen: prev ? Math.max(prev.lastSeen, ts) : ts,
        totalEvents: (prev?.totalEvents || 0) + 1,
      });
    }

    if (ts >= cutoff) {
      totalEvents++;
      byHour[hour24]++;
      if (event.access === 'Admit' || event.access === 'Open') { admits++; openCycles++; }
      else if (event.access === 'Deny') denies++;
      if (event.eventType === 'Hold Begin') holds++;
      if (event.eventType === 'Open Request') openCycles++;

      if (ts >= trafficCutoff) {
        const dayBucket = byDayMap.get(dateKey) || { admits: 0, denies: 0 };
        if (event.access === 'Admit' || event.access === 'Open') dayBucket.admits++;
        else if (event.access === 'Deny') dayBucket.denies++;
        byDayMap.set(dateKey, dayBucket);
      }

      if (event.lookup === 'card' && event.number && !ownerByCard.has(event.number)) {
        const cur = unknownCards.get(event.number) || { uses: 0, admits: 0, denies: 0, lastSeen: 0, lastMinute: '' };
        cur.uses++;
        if (event.access === 'Admit' || event.access === 'Open') cur.admits++;
        else if (event.access === 'Deny') cur.denies++;
        if (ts >= cur.lastSeen) { cur.lastSeen = ts; cur.lastMinute = minuteKey(ts); }
        unknownCards.set(event.number, cur);
      }

      if (event.lookup === 'entryCode' && event.number && event.access === 'Admit') {
        const cur = entryStats.get(event.number) || { uses: 0, days: new Set<string>(), offHours: 0, lastSeen: 0 };
        cur.uses++;
        cur.days.add(dateKey);
        if (hour24 >= 23 || hour24 < 5) cur.offHours++;
        if (ts > cur.lastSeen) cur.lastSeen = ts;
        entryStats.set(event.number, cur);
      }
    }
  }

  const dormant: DormantEntry[] = [];
  for (const res of residents) {
    if (!res.name.trim()) continue;
    const resCards = cardsByCode.get(res.directoryCode) || [];
    if (!res.entryCode && !resCards.length) continue;
    const activity = residentLastSeen.get(res.directoryCode);
    if (activity && activity.lastSeen >= cutoff) continue;
    dormant.push({
      directoryCode: res.directoryCode,
      name: res.name,
      type: res.type,
      entryCode: res.entryCode,
      cards: resCards,
      lastSeen: activity ? new Date(activity.lastSeen).toISOString() : null,
      totalEvents: activity?.totalEvents || 0,
    });
  }
  dormant.sort((first, second) => (first.lastSeen ? new Date(first.lastSeen).getTime() : 0) - (second.lastSeen ? new Date(second.lastSeen).getTime() : 0)
    || first.directoryCode.localeCompare(second.directoryCode));

  const unknownList: UnknownCardActivity[] = [...unknownCards.entries()]
    .map(([cardNumber, stats]) => ({
      cardNumber,
      uses: stats.uses,
      admits: stats.admits,
      denies: stats.denies,
      lastSeen: new Date(stats.lastSeen).toISOString(),
      lastMinute: stats.lastMinute,
      hasSnapshot: Boolean(snapshots[stats.lastMinute]?.files?.length),
    }))
    .sort((first, second) => second.uses - first.uses || second.lastSeen.localeCompare(first.lastSeen));

  const entryCodeList: EntryCodeUsage[] = [...entryStats.entries()]
    .map(([entryCode, stats]) => {
      const ownerCode = ownerByEntry.get(entryCode) || '';
      const owner = ownerCode ? residentByCode.get(ownerCode) : undefined;
      return {
        entryCode,
        directoryCode: ownerCode,
        name: owner?.name || '',
        type: owner?.type || '',
        uses: stats.uses,
        distinctDays: stats.days.size,
        offHoursUses: stats.offHours,
        lastSeen: new Date(stats.lastSeen).toISOString(),
        flagged: (stats.uses >= 30 && stats.days.size >= 10) || stats.offHours >= 10,
      };
    })
    .sort((first, second) => second.uses - first.uses);

  const byDay = [...byDayMap.entries()]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([date, counts]) => ({ date, ...counts }));

  return {
    days,
    dormant,
    unknownCards: unknownList,
    entryCodes: entryCodeList,
    traffic: { totalEvents, admits, denies, holds, openCycles, byHour, byDay },
  };
}
