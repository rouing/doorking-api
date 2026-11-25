import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodeRcvRelayNumbers } from '../src/board-files.ts';
import { minuteKey, minuteRelays, pendingMinutes } from '../src/camera-log.ts';
import { normalizeCameraSettings, type CameraConfig } from '../src/camera-settings.ts';
import { createFcmSender } from '../src/fcm.ts';
import { PUSH_APPROVAL_TTL_MS, PasskeyPushApprovals } from '../src/passkey-approvals.ts';
import { channelsForRelays, frameJobs } from '../src/snapshot-files.ts';
import type { CameraChannel } from '../src/types.ts';

function rawTx({ type = 2, admit = true, flags = 0x12 }: { type?: number; admit?: boolean; flags?: number }): string {
  const buf = Buffer.alloc(10, 0xff);
  buf[0] = 0x06; // June
  buf[1] = 0x15; // 15
  buf[2] = (admit ? 0x40 : 0x00) | 0x09; // 9 AM
  buf[3] = 0x30; // :30
  buf[4] = type;
  buf.writeUInt16BE(1234, 5);
  buf[7] = flags;
  return buf.toString('hex');
}

test('channelsForRelays: empty relays or unmapped channels returns all channels', () => {
  const allUnmapped: CameraChannel[] = [
    { channel: 1, name: 'Main' },
    { channel: 2, name: 'Exit' },
  ];
  assert.deepEqual(channelsForRelays(allUnmapped, new Set([0])), allUnmapped);
  assert.deepEqual(channelsForRelays(allUnmapped, new Set([1])), allUnmapped);

  const mapped: CameraChannel[] = [
    { channel: 1, name: 'Main', relays: [0] },
    { channel: 2, name: 'Exit', relays: [1] },
  ];
  assert.deepEqual(channelsForRelays(mapped, new Set()), mapped);
});

test('channelsForRelays: filters by relay, unions multi-relay minutes, and respects catch-all channels', () => {
  const channels: CameraChannel[] = [
    { channel: 1, name: 'Main', relays: [0] },
    { channel: 2, name: 'Side', relays: [1] },
    { channel: 3, name: 'Overview' },
  ];
  assert.deepEqual(channelsForRelays(channels, new Set([0])).map((c) => c.channel), [1, 3]);
  assert.deepEqual(channelsForRelays(channels, new Set([1])).map((c) => c.channel), [2, 3]);
  assert.deepEqual(channelsForRelays(channels, new Set([0, 1])).map((c) => c.channel), [1, 2, 3]);
  assert.deepEqual(channelsForRelays(channels, new Set([5])).map((c) => c.channel), [3]);

  const strictMapped: CameraChannel[] = [
    { channel: 1, name: 'Main', relays: [0] },
    { channel: 2, name: 'Side', relays: [1] },
  ];
  assert.deepEqual(channelsForRelays(strictMapped, new Set([0])).map((c) => c.channel), [1]);
  assert.deepEqual(channelsForRelays(strictMapped, new Set([1])).map((c) => c.channel), [2]);
  assert.deepEqual(channelsForRelays(strictMapped, new Set([0, 1])).map((c) => c.channel), [1, 2]);
  assert.deepEqual(channelsForRelays(strictMapped, new Set([4])).map((c) => c.channel), []);
});

test('channelsForRelays: null relay includes relay 0 channels, falling back to all when none include 0', () => {
  const withRelay0: CameraChannel[] = [
    { channel: 1, name: 'Main', relays: [0] },
    { channel: 2, name: 'Side', relays: [1] },
  ];
  assert.deepEqual(channelsForRelays(withRelay0, new Set([null])).map((c) => c.channel), [1]);

  const withoutRelay0: CameraChannel[] = [
    { channel: 2, name: 'Side', relays: [1] },
    { channel: 3, name: 'Rear', relays: [2] },
  ];
  assert.deepEqual(channelsForRelays(withoutRelay0, new Set([null])).map((c) => c.channel), [2, 3]);
});

test('normalizeCameraSettings validates and normalizes optional channel relays', () => {
  const cfg = normalizeCameraSettings({
    serial: 'ABC123456',
    username: 'admin',
    channels: [
      { channel: 1, name: 'Main', relays: [2, 0, 2] },
      { channel: 2, name: 'Overview', relays: [] },
      { channel: 3, name: 'Legacy' },
    ],
  });
  assert.deepEqual(cfg.channels, [
    { channel: 1, name: 'Main', relays: [0, 2] },
    { channel: 2, name: 'Overview' },
    { channel: 3, name: 'Legacy' },
  ]);
  assert.throws(() => normalizeCameraSettings({
    serial: 'ABC123456',
    username: 'admin',
    channels: [{ channel: 1, name: 'Bad', relays: [19] }],
  }), /0 to 18/);
  assert.throws(() => normalizeCameraSettings({
    serial: 'ABC123456',
    username: 'admin',
    channels: [{ channel: 1, name: 'Bad', relays: [-1] }],
  }), /0 to 18/);
});

test('decodeRcvRelayNumbers, minuteRelays, pendingMinutes, and frameJobs filter frames per relay', () => {
  assert.deepEqual(decodeRcvRelayNumbers({ raw: rawTx({ flags: 0x12 }) }), [0]);
  assert.deepEqual(decodeRcvRelayNumbers({ raw: rawTx({ flags: 0x00 }) }), [1]);
  assert.deepEqual(decodeRcvRelayNumbers({ raw: rawTx({ flags: 0x01 }) }), [2]);
  assert.deepEqual(decodeRcvRelayNumbers({ raw: rawTx({ flags: 0x02 }) }), [3]);
  assert.deepEqual(decodeRcvRelayNumbers({ raw: rawTx({ flags: 0x11 }) }), [18]);
  assert.deepEqual(decodeRcvRelayNumbers({ raw: rawTx({ flags: 0xfc }) }), [0, 1]);
  assert.deepEqual(decodeRcvRelayNumbers({ raw: rawTx({ type: 1, admit: false, flags: 0x12 }) }), []);

  const cfg: CameraConfig = normalizeCameraSettings({
    serial: 'ABC123456',
    username: 'admin',
    mode: 'snapshots',
    frames: 2,
    framesAfter: 0,
    channels: [
      { channel: 1, name: 'Main', relays: [0] },
      { channel: 2, name: 'Exit', relays: [1] },
    ],
  });
  const now = new Date(2026, 5, 15, 10, 0, 0).getTime();
  const min1 = new Date(2026, 5, 15, 9, 30, 0).getTime();
  const min2 = new Date(2026, 5, 15, 9, 35, 0).getTime();
  const min3 = new Date(2026, 5, 15, 9, 40, 0).getTime();
  const rows = [
    { ts: min1, eventType: 'Cards', access: 'Admit', relay: 0 },
    { ts: min2, eventType: 'Cards', access: 'Admit', relay: 0 },
    { ts: min2 + 10_000, eventType: 'Cards', access: 'Admit', relay: 1 },
    { ts: min3, eventType: 'Cards', access: 'Admit', relay: 5 }, // unmapped relay
  ];
  const relays = minuteRelays(cfg, rows);
  assert.deepEqual([...relays.get(minuteKey(min1))!], [0]);
  assert.deepEqual([...relays.get(minuteKey(min2))!].sort(), [0, 1]);
  assert.deepEqual([...relays.get(minuteKey(min3))!], [5]);

  const pending = pendingMinutes(cfg, rows, {}, now);
  assert.equal(pending.length, 2); // min3 skipped because no camera covers relay 5
  const byMin = Object.fromEntries(pending.map((p) => [p.minute, p]));
  assert.deepEqual(byMin[minuteKey(min1)].channels?.map((c) => c.channel), [1]);
  assert.deepEqual(byMin[minuteKey(min2)].channels?.map((c) => c.channel), [1, 2]);
  assert.deepEqual(frameJobs(cfg, byMin[minuteKey(min1)].channels).map((j) => j.file), ['ch1-00.jpg', 'ch1-30.jpg']);
});

test('PasskeyPushApprovals: create, 3 distinct 2-digit choices, approve, wrong number denies, expiry', () => {
  const pa = new PasskeyPushApprovals();
  const t0 = 1_700_000_000_000;

  const created = pa.create('Alice', 'sess-hash-1', { deviceLabel: 'Chrome on macOS', ip: '203.0.113.5' }, t0);
  assert.ok(created.id.length >= 16);
  assert.ok(created.challenge.length >= 32);
  assert.ok(created.numberMatch >= 10 && created.numberMatch <= 99);
  assert.equal(created.choices.length, 3);
  assert.equal(new Set(created.choices).size, 3);
  assert.ok(created.choices.every((n) => Number.isInteger(n) && n >= 10 && n <= 99));
  assert.ok(created.choices.includes(created.numberMatch));

  const pending = pa.listPendingForUser('alice', t0 + 1000);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, created.id);
  assert.equal(pending[0].challenge, created.challenge);
  assert.deepEqual(pending[0].choices, created.choices);
  assert.equal('numberMatch' in pending[0], false);

  // Wrong session or wrong user cannot read requester status.
  assert.equal(pa.getForRequester('alice', 'other-hash', created.id, t0 + 1000), null);
  assert.equal(pa.getForRequester('bob', 'sess-hash-1', created.id, t0 + 1000), null);
  assert.equal(pa.getForRequester('alice', 'sess-hash-1', created.id, t0 + 1000)?.status, 'pending');

  // Approve with matching number succeeds and returns approvalCode to requester.
  const ok = pa.approve('alice', created.id, created.numberMatch, 'ABCD2345', t0 + 2000);
  assert.deepEqual(ok, { ok: true, status: 'approved' });
  const afterApprove = pa.getForRequester('alice', 'sess-hash-1', created.id, t0 + 2000);
  assert.equal(afterApprove?.status, 'approved');
  assert.equal(afterApprove?.approvalCode, 'ABCD2345');
  assert.equal(pa.listPendingForUser('alice', t0 + 2000).length, 0);

  // Wrong number marks denied and prevents subsequent approval.
  const req2 = pa.create('alice', 'sess-hash-2', { deviceLabel: 'Firefox', ip: '198.51.100.7' }, t0);
  const wrongChoice = req2.choices.find((n) => n !== req2.numberMatch)!;
  assert.deepEqual(pa.approve('alice', req2.id, wrongChoice, 'XXXXYYYY', t0 + 1000), { ok: false, status: 'denied' });
  assert.equal(pa.getForRequester('alice', 'sess-hash-2', req2.id, t0 + 1000)?.status, 'denied');
  assert.equal(pa.getForRequester('alice', 'sess-hash-2', req2.id, t0 + 1000)?.approvalCode, undefined);
  assert.deepEqual(pa.approve('alice', req2.id, req2.numberMatch, 'ZZZZ2222', t0 + 1500), { ok: false, status: 'denied' });

  // Explicit deny marks denied.
  const req3 = pa.create('alice', 'sess-hash-3', { deviceLabel: 'Safari', ip: '198.51.100.8' }, t0);
  assert.deepEqual(pa.deny('alice', req3.id, t0 + 1000), { ok: true, status: 'denied' });
  assert.equal(pa.getForRequester('alice', 'sess-hash-3', req3.id, t0 + 1000)?.status, 'denied');

  // Expiry after PUSH_APPROVAL_TTL_MS.
  const req4 = pa.create('alice', 'sess-hash-4', { deviceLabel: 'Edge', ip: '198.51.100.9' }, t0);
  const afterExpiry = t0 + PUSH_APPROVAL_TTL_MS + 1;
  assert.equal(pa.listPendingForUser('alice', afterExpiry).length, 0);
  assert.deepEqual(pa.approve('alice', req4.id, req4.numberMatch, 'ABCD9999', afterExpiry), { ok: false, status: 'expired' });
  assert.equal(pa.getForRequester('alice', 'sess-hash-4', req4.id, afterExpiry)?.status, 'expired');
  pa.sweep(afterExpiry);
  assert.equal(pa.getForRequester('alice', 'sess-hash-4', req4.id, afterExpiry), null);
});

test('createFcmSender merges custom data fields into message.data', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-fcm-data-'));
  const saFile = path.join(tmpDir, 'sa.json');
  fs.writeFileSync(saFile, JSON.stringify({
    project_id: 'demo-doorking',
    client_email: 'fcm@demo-doorking.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token',
  }), { mode: 0o600 });

  const sentMessages: Array<Record<string, unknown>> = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok-xyz', expires_in: 3600 }), { status: 200 });
    }
    sentMessages.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('{"name":"projects/demo-doorking/messages/2"}', { status: 200 });
  }) as typeof fetch;

  try {
    const sender = createFcmSender(saFile, { fetchFn: mockFetch });
    assert.ok(sender);
    const res = await sender.send('device-token-12345678901234567890', {
      title: 'Approve passkey request',
      body: 'Chrome wants to add a passkey',
      tag: 'passkey-approval-1',
      data: {
        type: 'passkey_approval',
        requestId: 'req-1',
        choices: '[12,45,78]',
      },
    });
    assert.deepEqual(res, { ok: true });
    const msg = sentMessages[0].message as { data: Record<string, string> };
    assert.equal(msg.data.type, 'passkey_approval');
    assert.equal(msg.data.requestId, 'req-1');
    assert.equal(msg.data.choices, '[12,45,78]');
    assert.equal(msg.data.tag, 'passkey-approval-1');
    assert.equal(msg.data.url, '/');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
