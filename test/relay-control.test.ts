// Run with: node --test test/relay-control.test.ts
import test from 'node:test';
import assert from 'node:assert';
import * as dk from '../index.ts';

// Fake DKS client: GetRelays returns `status`, SetRelays records the Settings string.
function fakeClient(status, reply = 'OK') {
  const calls = [];
  return {
    calls,
    getRelays: () => Promise.resolve(status),
    setRelays: (u, p, ph, m, settings) => { calls.push(settings); return Promise.resolve(reply); },
  };
}
const cred = { user: 'u', password: 'p', phoneNumber: '1', masterCode: 'm', retryMs: 1 };

test('controlRelays: 20-char Settings = mode letter + 19 states; main-board change -> M', async () => {
  const c = fakeClient('0000000000000000000');
  const r = await dk.controlRelays(c, cred, { 1: true });
  assert.strictEqual(r.settings, 'M0100000000000000000');
  assert.strictEqual(r.settings.length, 20);
});

test('controlRelays: untouched relays echo current; unknown (2) sent as 0', async () => {
  const c = fakeClient('2100000000000000000'); // relay0 unknown, relay1 on
  const r = await dk.controlRelays(c, cred, { 2: true });
  // relay0 2->0, relay1 stays 1, relay2 set 1, rest 0, mode M (no bank 3-18 change)
  assert.strictEqual(r.settings, 'M0110000000000000000');
});

test('controlRelays: mode letter reflects which banks change (FUN_004f1c20)', async () => {
  const mode = async (status, desired) => (await dk.controlRelays(fakeClient(status), cred, desired)).settings[0];
  const base = '0000000000000000000';
  assert.strictEqual(await mode(base, { 1: true }), 'M'); // main board only
  assert.strictEqual(await mode(base, { 5: true }), 'R'); // relays 3-10
  assert.strictEqual(await mode(base, { 12: true }), 'P'); // relays 11-18
  assert.strictEqual(await mode(base, { 5: true, 12: true }), 'T'); // both banks
  // Unused Tracker relays reporting unknown (2) are left alone, so they are no change.
  const unknown = '0002222222222222222';
  assert.strictEqual(await mode(unknown, { 1: true }), 'M');
  assert.strictEqual(await mode(unknown, { 5: true }), 'R');
  const sent = await dk.controlRelays(fakeClient(unknown), cred, { 12: true });
  assert.deepStrictEqual([sent.settings[0], sent.settings.slice(1)], ['P', '0000000000001000000']);
});

test('controlRelays: retries on timeout reply, then succeeds', async () => {
  let n = 0;
  const c = {
    getRelays: () => Promise.resolve('0000000000000000000'),
    setRelays: (u, p, ph, m, s) => { n += 1; return Promise.resolve(n < 3 ? 'Error: a network timeout error has occurred.' : 'OK'); },
  };
  const r = await dk.controlRelays(c, cred, { 1: true });
  assert.strictEqual(r.reply, 'OK');
  assert.strictEqual(n, 3);
});
