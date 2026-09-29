// Local-only synthetic users for manual production-build browser smoke checks.
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const local = getLocalSupabaseStatus();
const address = new URL(local.API_URL);
if (address.hostname !== '127.0.0.1' || address.port !== '55431')
  throw new Error('Browser smoke setup only supports the local Supabase API');
const password = 'LocalPhase5#123';

function client(key) {
  return createClient(local.API_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
async function value(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
async function signedIn(email) {
  const account = client(local.ANON_KEY);
  await value(account.auth.signInWithPassword({ email, password }));
  return account;
}

if (process.argv[2] === 'setup') {
  const suffix = `${Date.now()}`;
  const aEmail = `phase5-browser-a-${suffix}@test.local`;
  const bEmail = `phase5-browser-b-${suffix}@test.local`;
  const admin = client(local.SERVICE_ROLE_KEY);
  const a = await value(admin.auth.admin.createUser({ email: aEmail, password, email_confirm: true }));
  const b = await value(admin.auth.admin.createUser({ email: bEmail, password, email_confirm: true }));
  const owner = await signedIn(aEmail);
  const projectId = await value(owner.rpc('create_project', { p_name: `Phase 5 browser ${suffix}`, p_description: 'Local smoke' }));
  await value(owner.rpc('add_project_member', { p_project_id: projectId, p_user_id: b.user.id, p_role: 'member' }));
  const taskId = await value(owner.rpc('create_task', { p_project_id: projectId, p_title: 'Монтаж окон', p_description: 'Local smoke' }));
  const itemId = await value(owner.rpc('create_task_item', { p_task_id: taskId, p_title: 'Оконные блоки установлены' }));
  await value(owner.rpc('set_task_item_percentage', { p_task_item_id: itemId, p_percentage: 20 }));
  const item = await value(owner.from('task_items').select('sync_version,percentage').eq('id', itemId).single());
  console.log(JSON.stringify({ aEmail, bEmail, password, projectId, taskId, itemId, version: item.sync_version, percentage: item.percentage }));
} else if (process.argv[2] === 'remote') {
  const [, , , email, itemId, percentageText] = process.argv;
  const percentage = Number(percentageText);
  if (!email?.includes('@test.local') || !/^[0-9a-f-]{36}$/i.test(itemId ?? '') || !Number.isInteger(percentage))
    throw new Error('Usage: remote <local-test-email> <item-uuid> <percentage>');
  const remote = await signedIn(email);
  await value(remote.rpc('set_task_item_percentage', { p_task_item_id: itemId, p_percentage: percentage }));
  const item = await value(remote.from('task_items').select('sync_version,percentage').eq('id', itemId).single());
  console.log(JSON.stringify({ itemId, version: item.sync_version, percentage: item.percentage }));
} else {
  throw new Error('Usage: node scripts/phase5-browser-smoke.mjs setup|remote');
}
