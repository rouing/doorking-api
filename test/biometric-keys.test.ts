import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { BiometricChallenges, parseP256SpkiKey } from '../src/biometric-keys.ts';
import { fillResidentInstructionsPdf } from '../src/resident-pdf.ts';

test('parseP256SpkiKey accepts ECDSA P-256 SPKI DER keys and rejects RSA or junk', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const parsed = parseP256SpkiKey(spki);
  assert.equal(parsed.spkiBase64, spki);
  assert.equal(parsed.keyObject.asymmetricKeyType, 'ec');

  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsaSpki = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.throws(() => parseP256SpkiKey(rsaSpki), /P-256/);
  assert.throws(() => parseP256SpkiKey('not-a-key'), /P-256/);
});

test('BiometricChallenges issues single-use challenges bound to username and keyId', () => {
  const challenges = new BiometricChallenges();
  const c = challenges.issue('Alice', 'key-123', 1000);
  assert.ok(c.length >= 32);
  // Wrong user or wrong keyId is refused and consumes the challenge.
  assert.equal(challenges.consume(c, 'bob', 'key-123', 2000), false);
  // Replay after failed attempt is also refused.
  assert.equal(challenges.consume(c, 'alice', 'key-123', 2000), false);

  const c2 = challenges.issue('Alice', 'key-123', 1000);
  assert.equal(challenges.consume(c2, 'alice', 'key-123', 2000), true);
  assert.equal(challenges.consume(c2, 'alice', 'key-123', 2000), false);

  // Expired challenge is refused.
  const c3 = challenges.issue('Alice', 'key-123', 1000);
  assert.equal(challenges.consume(c3, 'alice', 'key-123', 1000 + 3 * 60_000), false);
});

test('ECDSA P-256 hardware signature round-trips with node:crypto SHA256 verification', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const { keyObject } = parseP256SpkiKey(spki);
  const challenge = new BiometricChallenges().issue('alice', 'dev-1');
  const sig = crypto.sign('sha256', Buffer.from(challenge, 'utf8'), privateKey);
  assert.equal(crypto.verify('sha256', Buffer.from(challenge, 'utf8'), keyObject, sig), true);
  assert.equal(crypto.verify('sha256', Buffer.from(`${challenge}x`, 'utf8'), keyObject, sig), false);
});

test('fillResidentInstructionsPdf sanitizes non-Latin/emoji characters without throwing', async () => {
  const pdf = await fillResidentInstructionsPdf({
    residentName: 'Łukasz Żółć 🏠',
    directoryCode: '101',
    entryCode: '4821',
    adminPhone: '(214) 555-0100 📞',
    grantAccessDigit: '9',
  });
  assert.ok(pdf.byteLength > 1000);
});
