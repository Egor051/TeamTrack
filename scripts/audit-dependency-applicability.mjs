// Bounded local advisory probes using synthetic inputs and disposable test keys.
// This evaluates installed dependencies; it does not claim an application exploit.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
const require = createRequire(import.meta.url);
const output = resolve(process.env.TASKTRACE_SECURITY_EVIDENCE || '.expo/security-evidence');
mkdirSync(output, { recursive: true });
const probe = spawnSync(process.execPath, ['--stack-size=512', '-e', `
  const braces=require('braces');
  try { braces.expand('{'.repeat(4500)+'a,b'+'}'.repeat(4500)); console.log('accepted'); }
  catch(e) { console.log(e.name); process.exitCode=e instanceof RangeError?0:1; }
`], { cwd: process.cwd(), encoding: 'utf8', timeout: 3000, maxBuffer: 64000, windowsHide: true });
assert.equal(probe.status, 0, probe.stderr); assert.match(probe.stdout, /RangeError/);
const braces = require('braces'); let braceCalls = 0;
require.cache[require.resolve('braces')].exports = new Proxy(braces, {
  apply() { braceCalls++; throw Error('Vulnerable braces call reached'); },
  get(target, key) { if (typeof target[key] === 'function') return () => { braceCalls++; throw Error('Vulnerable braces method reached'); }; return target[key]; },
});
const { includedByGlob } = require(resolve('node_modules/metro-file-map/src/watchers/common.js'));
assert(includedByGlob('f', ['**/*.tsx', '**/package.json'], true, 'src/app/(app)/templates.tsx'));
assert(!includedByGlob('f', ['**/*.tsx'], true, '{'.repeat(6000) + 'a,b' + '}'.repeat(6000) + '.json'));
assert(includedByGlob('f', ['**/*.{js,ts,tsx}'], true, 'src/file.ts'));
assert.equal(braceCalls, 0);
const forge = require('node-forge');
const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const privateKey = forge.pki.privateKeyFromPem(pair.privateKey), publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
const message = 'Synthetic local applicability probe';
const digest = forge.md.sha256.create().update(message).digest().getBytes();
const a = forge.asn1, node = (type, constructed, value) => a.create(a.Class.UNIVERSAL, type, constructed, value);
const info = node(a.Type.SEQUENCE, true, [node(a.Type.SEQUENCE, true, [
  node(a.Type.OID, false, a.oidToDer(forge.pki.oids.sha256).getBytes()),
  node(a.Type.NULL, false, ''), node(a.Type.OCTETSTRING, false, 'extra nested bytes'),
]), node(a.Type.OCTETSTRING, false, digest)]);
// We own the private key: this demonstrates parser acceptance, NOT keyless forgery.
const malformed = privateKey.sign(a.toDer(info).getBytes(), 'NONE');
assert.equal(publicKey.verify(digest, malformed), true);
assert.equal(verify('sha256', Buffer.from(message), pair.publicKey, Buffer.from(malformed, 'binary')), false);
const normal = privateKey.sign(forge.md.sha256.create().update(message));
assert.equal(verify('sha256', Buffer.from(message), pair.publicKey, Buffer.from(normal, 'binary')), true);
const result = { braces: { installed: require('braces/package.json').version, bounded_direct_stack_exhaustion: true, probe_stack_kib: 512, pattern_length: 9003,
  actual_metro_watcher_calls_to_braces: braceCalls, patterns_from_metro_config_not_application_fields: true },
  forge: { installed: require('node-forge/package.json').version, malformed_nested_digest_accepted: true,
    openssl_rejected_same_signature: true, normal_signature_valid: true, synthetic_key_bits: 2048, exponent: 65537,
    keyless_forgery_demonstrated: false }, dependency_fixed: false };
writeFileSync(resolve(output, 'dependency-applicability.json'), JSON.stringify(result, null, 2));
console.log('PASS applicability probes: braces recursion fails with bounded 512 KiB stack/9003-char input; actual Metro watcher makes zero braces calls; malformed own-key DigestInfo accepted by forge and rejected by OpenSSL (not a keyless forgery)');
