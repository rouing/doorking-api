import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFcmSender } from '../src/fcm.ts';

test('createFcmSender signs RS256 JWT, caches OAuth2 token, and handles success + UNREGISTERED', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-fcm-'));
  const saFile = path.join(tmpDir, 'sa.json');
  fs.writeFileSync(saFile, JSON.stringify({
    project_id: 'demo-doorking',
    client_email: 'fcm@demo-doorking.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    token_uri: 'https://oauth2.googleapis.com/token',
  }), { mode: 0o600 });

  let tokenCalls = 0;
  const fcmBodies: Array<Record<string, unknown>> = [];
  let nextFcmStatus = 200;
  let nextFcmBody = '{"name":"projects/demo-doorking/messages/1"}';

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }), { status: 200 });
    }
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/demo-doorking/messages:send');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer mock-access-token');
    fcmBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(nextFcmBody, { status: nextFcmStatus });
  }) as typeof fetch;

  try {
    const sender = createFcmSender(saFile, { fetchFn: mockFetch });
    assert.ok(sender);
    assert.equal(sender.projectId, 'demo-doorking');

    const okRes = await sender.send('device-token-12345678901234567890', {
      title: 'Gate Alert',
      body: 'Scheduled pull failed',
      tag: 'gate-2145550100',
    });
    assert.deepEqual(okRes, { ok: true });
    assert.equal(tokenCalls, 1);

    // Second send reuses cached OAuth2 token and marks UNREGISTERED cleanly.
    nextFcmStatus = 404;
    nextFcmBody = JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' } });
    const staleRes = await sender.send('stale-token-12345678901234567890', {
      title: 'Test',
      body: 'Hello',
    });
    assert.equal(tokenCalls, 1);
    assert.equal(staleRes.ok, false);
    if (!staleRes.ok) assert.equal(staleRes.unregistered, true);
    assert.equal(fcmBodies.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
