import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
const local = getLocalSupabaseStatus();
if (local.kind !== 'tasktrace-isolated-security-test') throw Error('Disposable stack required');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const [admin, owner, reader, anon] = [local.SERVICE_ROLE_KEY, local.ANON_KEY, local.ANON_KEY, local.ANON_KEY].map(key => createClient(local.API_URL, key, options));
const value = async p => { const r = await p; if (r.error) throw r.error; return r.data; };
const pause = ms => new Promise(r => setTimeout(r, ms));
async function subscribe(client, allowed = true) {
  const events = [], ch = client.channel('templates', { config: { private: true } });
  ch.on('broadcast', { event: 'invalidate' }, e => events.push(e.payload));
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(Error('Template channel join timeout')), 10000);
    ch.subscribe((s, e) => {
      if (s === 'SUBSCRIBED' || s === 'CHANNEL_ERROR') {
        clearTimeout(timer);
        if ((s === 'SUBSCRIBED') === allowed) ok(); else no(e || Error('Unexpected template channel authorization'));
      }
    });
  });
  return { ch, events };
}
try {
  for (const [i, client] of [owner, reader].entries()) {
    const email = `template-realtime-${process.pid}-${i}@test.local`, password = 'LibrarySecurity9!';
    await value(admin.auth.admin.createUser({ email, password, email_confirm: true }));
    await value(client.auth.signInWithPassword({ email, password }));
  }
  const subscription = await subscribe(reader);
  const denied = await subscribe(anon, false); await anon.removeChannel(denied.ch);
  const id = await value(owner.rpc('create_task_template', { p_name: 'Opaque global fixture', p_description: 'Must not broadcast' }));
  for (let n = 0; n < 100 && !subscription.events.length; n++) await pause(50);
  assert(subscription.events.length > 0);
  assert.equal((await value(reader.rpc('get_task_template', { p_template_id: id }))).name, 'Opaque global fixture');
  assert.equal((await reader.rpc('update_task_template', { p_template_id: id, p_name: 'Forbidden' })).error?.code, '42501');
  // Verify SELECT-only channel authorization also prevents client forgery.
  const observer = await subscribe(owner);
  const before = subscription.events.length;
  // A Phoenix transport ack can be "ok" even when authorization drops a
  // publish. A second client verifies actual non-delivery (self is false).
  await subscription.ch.send({ type: 'broadcast', event: 'invalidate', payload: { table: 'task_templates', operation: 'DELETE', name: 'Injected' } }, { timeout: 2000 });
  await pause(600);
  assert.equal(observer.events.length, 0); assert.equal(subscription.events.length, before);
  await value(owner.rpc('archive_task_template', { p_template_id: id }));
  for (let n = 0; n < 100 && subscription.events.length === before; n++) await pause(50);
  assert(subscription.events.length > before);
  assert.equal(await value(reader.rpc('get_task_template', { p_template_id: id })), null);
  for (const payload of subscription.events) {
    assert.deepEqual(Object.keys(payload).filter(k => k !== 'id').sort(), ['operation', 'table']);
    assert.notEqual(payload.id, id); assert.equal(payload.table, 'task_templates');
  }
  console.log('PASS template Realtime security: authenticated global read, anonymous join denied, foreign writes denied, client Broadcast injection denied, archived content absent, opaque events');
} finally {
  for (const client of [admin, owner, reader, anon]) { await client.removeAllChannels(); client.realtime.disconnect(); }
}
