import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const local = getLocalSupabaseStatus();
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `pkce-${nonce}@test.local`;
const password = 'LocalPkcePass9Z!';
const updatedPassword = 'LocalPkcePass8Y!';
const webRedirect = 'http://127.0.0.1:8081/login?auth_type=signup';
const nativeRedirect = 'com.teamtrack.tasktrace://reset-password?auth_type=recovery';
const expectedCallbacks = new Map([
  ['signup', new URL(webRedirect)],
  ['recovery', new URL(nativeRedirect)],
]);

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

function authClient(storage) {
  return createClient(local.API_URL, local.ANON_KEY, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
      storage,
      flowType: 'pkce',
      experimental: { appendPkceFlowIdToRedirects: true },
    },
  });
}

const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});

function decodeHtml(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&#x3D;', '=').replaceAll('&#61;', '=');
}

async function mailpitMessages() {
  const response = await fetch(`${local.MAILPIT_URL}/api/v1/messages`);
  assert.equal(response.ok, true, `Mailpit list failed with ${response.status}`);
  return (await response.json()).messages ?? [];
}

async function waitForMail(afterIds) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const messages = await mailpitMessages();
    const match = messages.find((message) => {
      if (afterIds.has(message.ID)) return false;
      return (message.To ?? []).some((recipient) => recipient.Address?.toLowerCase() === email);
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No local email arrived for ${email}`);
}

async function verifyLinkFromMail(message) {
  const response = await fetch(`${local.MAILPIT_URL}/api/v1/message/${encodeURIComponent(message.ID)}`);
  assert.equal(response.ok, true, `Mailpit message fetch failed with ${response.status}`);
  const detail = await response.json();
  const body = decodeHtml(`${detail.HTML ?? ''}\n${detail.Text ?? ''}`);
  const candidates = body.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const verifyUrl = candidates.find((value) => value.includes('/auth/v1/verify?'));
  assert.ok(verifyUrl, 'Supabase verification URL was absent from local email');

  const verify = await fetch(verifyUrl, { redirect: 'manual' });
  assert.ok(verify.status >= 300 && verify.status < 400, `GoTrue verify returned ${verify.status}`);
  const location = verify.headers.get('location');
  assert.ok(location, 'GoTrue verify response did not contain a callback location');
  return new URL(location);
}

function assertStrictCallback(callback, kind) {
  const expected = expectedCallbacks.get(kind);
  assert.equal(callback.protocol, expected.protocol);
  assert.equal(callback.hostname, expected.hostname);
  assert.equal(callback.port, expected.port);
  assert.equal(callback.pathname.replace(/\/$/, ''), expected.pathname.replace(/\/$/, ''));
  assert.equal(callback.searchParams.get('auth_type'), kind);
  assert.match(callback.searchParams.get('code') ?? '', /^[A-Za-z0-9._~-]{8,4096}$/);
  assert.match(callback.searchParams.get('sb_flow_id') ?? '', /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(callback.hash, '');
  assert.deepEqual([...new Set(callback.searchParams.keys())].sort(), ['auth_type', 'code', 'sb_flow_id']);
}

async function exchange(client, callback) {
  const result = await client.auth.exchangeCodeForSession(callback.searchParams.get('code'), {
    flowId: callback.searchParams.get('sb_flow_id'),
  });
  if (result.error) throw result.error;
  assert.equal(result.data.session?.user.email, email);
}

let userId;
const signupStorage = memoryStorage();
const signupClient = authClient(signupStorage);
const recoveryStorage = memoryStorage();
const recoveryClient = authClient(recoveryStorage);

try {
  const beforeSignup = new Set((await mailpitMessages()).map((message) => message.ID));
  const signup = await signupClient.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: webRedirect, data: { display_name: `PKCE ${nonce}` } },
  });
  if (signup.error) throw signup.error;
  userId = signup.data.user?.id;
  assert.ok(userId);
  assert.equal(signup.data.session, null, 'email confirmation unexpectedly returned a session');

  const signupCallback = await verifyLinkFromMail(await waitForMail(beforeSignup));
  assertStrictCallback(signupCallback, 'signup');
  await exchange(signupClient, signupCallback);
  await signupClient.auth.signOut({ scope: 'local' });

  const beforeRecovery = new Set((await mailpitMessages()).map((message) => message.ID));
  const recovery = await recoveryClient.auth.resetPasswordForEmail(email, { redirectTo: nativeRedirect });
  if (recovery.error) throw recovery.error;
  const recoveryCallback = await verifyLinkFromMail(await waitForMail(beforeRecovery));
  assertStrictCallback(recoveryCallback, 'recovery');
  await exchange(recoveryClient, recoveryCallback);

  const passwordUpdate = await recoveryClient.auth.updateUser({ password: updatedPassword });
  if (passwordUpdate.error) throw passwordUpdate.error;
  await recoveryClient.auth.signOut({ scope: 'local' });
  const passwordSignIn = await recoveryClient.auth.signInWithPassword({ email, password: updatedPassword });
  if (passwordSignIn.error) throw passwordSignIn.error;

  console.log('Local GoTrue web/native PKCE integration tests passed.');
} finally {
  await signupClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
  await recoveryClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
  signupClient.realtime.disconnect();
  recoveryClient.realtime.disconnect();
  admin.realtime.disconnect();
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => undefined);
}
