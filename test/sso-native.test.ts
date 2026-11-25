import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import * as dk from '../index.ts';

function googleProvider(overrides = {}) {
  return {
    id: 'google',
    name: 'Google',
    issuer: 'https://accounts.google.com',
    clientId: '1234567890-abc.apps.googleusercontent.com',
    clientSecret: 'test-secret',
    allowedDomains: [],
    autoCreate: false,
    passwords: true,
    maxAgeHours: 0,
    ...overrides,
  };
}

function signJwt({ header, payload, privateKey, alg = 'RS256' }) {
  const headerB64 = Buffer.from(JSON.stringify({ alg, typ: 'JWT', ...header })).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = alg === 'ES256'
    ? crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    : crypto.sign('sha256', Buffer.from(signingInput), privateKey);
  return `${signingInput}.${sig.toString('base64url')}`;
}

test('SsoFlows 60s native callback cache replays exact doorking:// redirect and expires after 60s', () => {
  const sso = new dk.SsoFlows();
  const t0 = 1_700_000_000_000;
  const redirectUrl = 'doorking://sso/callback?code=abc123XYZ';

  assert.equal(sso.getNativeCallback('state-1', t0), undefined);
  assert.equal(sso.getNativeCallback(null, t0), undefined);
  assert.equal(sso.getNativeCallback('', t0), undefined);

  sso.rememberNativeCallback('state-1', redirectUrl, t0);
  // Duplicate hits within 60s return the exact cached redirect URL without consuming it.
  assert.equal(sso.getNativeCallback('state-1', t0 + 1_000), redirectUrl);
  assert.equal(sso.getNativeCallback('state-1', t0 + 59_999), redirectUrl);
  // Unknown state still misses.
  assert.equal(sso.getNativeCallback('other-state', t0 + 1_000), undefined);
  // Expires at/after 60s.
  assert.equal(sso.getNativeCallback('state-1', t0 + 60_000), undefined);
  assert.equal(sso.getNativeCallback('state-1', t0 + 60_001), undefined);
});

test('verifyGoogleIdToken verifies RS256 and ES256 JWTs, enforces single-use nonce, claims, signature, and Workspace hd', async () => {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-kid-1', use: 'sig', alg: 'RS256' };
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-kid-1', use: 'sig', alg: 'ES256' };
  const jwks = { keys: [rsaJwk, ecJwk] };

  const sso = new dk.SsoFlows();
  const now = 1_700_000_000_000;
  const nowSec = Math.floor(now / 1000);
  const baseProvider = googleProvider();

  const makeValidClaims = (nonce, extra = {}) => ({
    iss: 'https://accounts.google.com',
    aud: baseProvider.clientId,
    sub: 'google-sub-123',
    email: 'Admin@Example.com',
    email_verified: true,
    name: 'Admin User',
    iat: nowSec - 10,
    exp: nowSec + 3600,
    nonce,
    ...extra,
  });

  // 1. Valid RS256 token succeeds and returns normalized identity + native: true.
  const n1 = sso.issueGoogleNonce(baseProvider.id, now);
  const t1 = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(n1, { auth_time: nowSec - 30, amr: ['mfa'] }), privateKey: rsa.privateKey });
  const r1 = await dk.verifyGoogleIdToken(sso, baseProvider, t1, n1, now, undefined, jwks);
  assert.equal(r1.mode, 'signin');
  assert.equal(r1.native, true);
  assert.equal(r1.strong, true);
  assert.equal(r1.identity.subject, 'google-sub-123');
  assert.equal(r1.identity.email, 'admin@example.com');
  assert.equal(r1.identity.emailVerified, true);

  // 2. Nonce is strictly single-use: replaying the same token+nonce fails with 401.
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, t1, n1, now + 1000, undefined, jwks),
    (e) => e.status === 401 && /expired or was already used/.test(e.message),
  );

  // 3. Valid ES256 token also succeeds (ieee-p1363 signature).
  const nEs = sso.issueGoogleNonce(baseProvider.id, now);
  const tEs = signJwt({ header: { kid: 'ec-kid-1' }, payload: makeValidClaims(nEs, { iss: 'accounts.google.com', aud: ['other-aud', baseProvider.clientId] }), privateKey: ec.privateKey, alg: 'ES256' });
  const rEs = await dk.verifyGoogleIdToken(sso, baseProvider, tEs, nEs, now, undefined, jwks);
  assert.equal(rEs.identity.subject, 'google-sub-123');

  // 4. Rejects non-Google provider with 400.
  const entra = googleProvider({ id: 'entra', name: 'Entra', issuer: 'https://login.microsoftonline.com/common/v2.0' });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, entra, t1, 'any-nonce', now, undefined, jwks),
    (e) => e.status === 400,
  );

  // 5. Rejects expired nonce (after 5 minutes).
  const nExpired = sso.issueGoogleNonce(baseProvider.id, now);
  const tExpiredNonce = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nExpired), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, tExpiredNonce, nExpired, now + 5 * 60_000, undefined, jwks),
    (e) => e.status === 401 && /expired or was already used/.test(e.message),
  );

  // 6. Rejects wrong aud.
  const nAud = sso.issueGoogleNonce(baseProvider.id, now);
  const tAud = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nAud, { aud: 'wrong-client.apps.googleusercontent.com' }), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, tAud, nAud, now, undefined, jwks),
    (e) => e.status === 401 && /audience/.test(e.message),
  );

  // 7. Rejects wrong iss.
  const nIss = sso.issueGoogleNonce(baseProvider.id, now);
  const tIss = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nIss, { iss: 'https://evil.example.com' }), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, tIss, nIss, now, undefined, jwks),
    (e) => e.status === 401 && /issuer/.test(e.message),
  );

  // 8. Rejects expired exp (beyond 60s skew).
  const nExp = sso.issueGoogleNonce(baseProvider.id, now);
  const tExp = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nExp, { exp: nowSec - 61 }), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, tExp, nExp, now, undefined, jwks),
    (e) => e.status === 401 && /expired/.test(e.message),
  );

  // 9. Rejects iat more than 5 minutes in the future.
  const nIat = sso.issueGoogleNonce(baseProvider.id, now);
  const tIat = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nIat, { iat: nowSec + 301 }), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, tIat, nIat, now, undefined, jwks),
    (e) => e.status === 401 && /issued-at/.test(e.message),
  );

  // 10. Rejects mismatched nonce inside JWT.
  const nMismatch = sso.issueGoogleNonce(baseProvider.id, now);
  const tMismatch = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims('different-nonce'), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, tMismatch, nMismatch, now, undefined, jwks),
    (e) => e.status === 401 && /nonce/.test(e.message),
  );

  // 11. Rejects tampered signature.
  const nTamper = sso.issueGoogleNonce(baseProvider.id, now);
  const tTamper = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nTamper), privateKey: rsa.privateKey });
  const segs = tTamper.split('.');
  const badPayload = Buffer.from(JSON.stringify(makeValidClaims(nTamper, { sub: 'evil-sub' }))).toString('base64url');
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, `${segs[0]}.${badPayload}.${segs[2]}`, nTamper, now, undefined, jwks),
    (e) => e.status === 401 && /signature/.test(e.message),
  );

  // 12. Rejects unverified email.
  const nUnverified = sso.issueGoogleNonce(baseProvider.id, now);
  const tUnverified = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nUnverified, { email_verified: false }), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, baseProvider, tUnverified, nUnverified, now, undefined, jwks),
    (e) => e.status === 403 && /verified/.test(e.message),
  );

  // 13. Enforces Google Workspace allowedDomains + hd claim.
  const workspaceProvider = googleProvider({ allowedDomains: ['example.com'] });

  // Wrong email domain rejected.
  const nDom = sso.issueGoogleNonce(workspaceProvider.id, now);
  const tDom = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nDom, { email: 'user@other.com', hd: 'other.com' }), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, workspaceProvider, tDom, nDom, now, undefined, jwks),
    (e) => e.status === 403 && /example\.com/.test(e.message),
  );

  // Personal Google account with work email (missing hd) rejected.
  const nNoHd = sso.issueGoogleNonce(workspaceProvider.id, now);
  const tNoHd = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nNoHd, { email: 'admin@example.com' }), privateKey: rsa.privateKey });
  await assert.rejects(
    dk.verifyGoogleIdToken(sso, workspaceProvider, tNoHd, nNoHd, now, undefined, jwks),
    (e) => e.status === 403 && /Workspace/.test(e.message),
  );

  // Valid Workspace account with matching hd succeeds.
  const nOkHd = sso.issueGoogleNonce(workspaceProvider.id, now);
  const tOkHd = signJwt({ header: { kid: 'rsa-kid-1' }, payload: makeValidClaims(nOkHd, { email: 'admin@example.com', hd: 'Example.com' }), privateKey: rsa.privateKey });
  const rOkHd = await dk.verifyGoogleIdToken(sso, workspaceProvider, tOkHd, nOkHd, now, undefined, jwks);
  assert.equal(rOkHd.identity.email, 'admin@example.com');
  assert.equal(rOkHd.identity.hd, 'example.com');
});
