import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const local = getLocalSupabaseStatus();
const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};
const authAdmin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, clientOptions);
const service = createClient(local.API_URL, local.SERVICE_ROLE_KEY, clientOptions);
const owner = createClient(local.API_URL, local.ANON_KEY, clientOptions);
const adminA = createClient(local.API_URL, local.ANON_KEY, clientOptions);
const adminB = createClient(local.API_URL, local.ANON_KEY, clientOptions);
const member = createClient(local.API_URL, local.ANON_KEY, clientOptions);
const viewer = createClient(local.API_URL, local.ANON_KEY, clientOptions);
const outsider = createClient(local.API_URL, local.ANON_KEY, clientOptions);
const clients = [owner, adminA, adminB, member, viewer, outsider, service, authAdmin];
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = 'LocalTestPass9Z!';
const identities = {};
let projectId;
let taskId;
let itemId;

async function rpc(client, name, args) {
  const result = await client.rpc(name, args);
  if (result.error) throw result.error;
  return result.data;
}

async function createAndSignIn(label, client) {
  const email = `backend-${label}-${nonce}@test.local`;
  const created = await authAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: `Backend ${label}` },
  });
  if (created.error) throw created.error;
  identities[label] = { id: created.data.user.id, email };
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
}

function subscribe(channel, allowed = true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Realtime subscription timed out')), 10_000);
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout);
        if (!allowed) reject(new Error('Unauthorized private channel subscribed'));
        else resolve(status);
      } else if (status === 'CHANNEL_ERROR') {
        clearTimeout(timeout);
        if (allowed) reject(error ?? new Error('Authorized private channel failed'));
        else resolve(status);
      } else if (status === 'TIMED_OUT') {
        clearTimeout(timeout);
        reject(error ?? new Error('Realtime subscription timed out'));
      }
    });
  });
}

function nextBroadcast(channel, table) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No ${table} Broadcast invalidation received`)), 10_000);
    channel.on('broadcast', { event: 'invalidate' }, (message) => {
      if (message?.payload?.table !== table) return;
      clearTimeout(timeout);
      resolve(message.payload);
    });
  });
}

function assertMinimalInvalidation(payload, table, operation) {
  assert.deepEqual(Object.keys(payload).sort(), ['id', 'operation', 'table']);
  assert.match(payload.id, /^[0-9a-f-]{36}$/i);
  assert.equal(payload.table, table);
  assert.equal(payload.operation, operation);
}

async function expectNoPostgresChange(channel, mutate) {
  let count = 0;
  channel.on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => { count += 1; });
  await subscribe(channel, true);
  await mutate();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(count, 0, 'application table unexpectedly emitted Postgres Changes');
}

try {
  await Promise.all([
    createAndSignIn('owner', owner),
    createAndSignIn('admin-a', adminA),
    createAndSignIn('admin-b', adminB),
    createAndSignIn('member', member),
    createAndSignIn('viewer', viewer),
    createAndSignIn('outsider', outsider),
  ]);

  projectId = await rpc(owner, 'create_project', { p_name: `Backend integration ${nonce}`, p_description: 'Data API verification' });
  await rpc(owner, 'add_project_member', { p_project_id: projectId, p_user_id: identities['admin-a'].id, p_role: 'admin' });
  await rpc(owner, 'add_project_member', { p_project_id: projectId, p_user_id: identities['admin-b'].id, p_role: 'admin' });
  await rpc(owner, 'add_project_member', { p_project_id: projectId, p_user_id: identities.member.id, p_role: 'member' });
  await rpc(owner, 'add_project_member', { p_project_id: projectId, p_user_id: identities.viewer.id, p_role: 'viewer' });
  taskId = await rpc(owner, 'create_task', { p_project_id: projectId, p_title: 'Backend stage', p_description: 'Before' });
  itemId = await rpc(owner, 'create_task_item', { p_task_id: taskId, p_title: 'Before' });

  // TT-H01: the exact app-shaped RPC resolves, while the removed overload does not.
  const appShape = await owner.rpc('update_task_item', { p_task_item_id: itemId, p_title: 'App-shaped update' });
  assert.equal(appShape.error, null, appShape.error?.message);
  const removedOverload = await owner.rpc('update_task_item', {
    p_task_item_id: itemId,
    p_title: 'Legacy overload',
    p_description: null,
    p_position: null,
    p_comment: null,
  });
  assert.ok(removedOverload.error, 'removed five-argument overload remained callable');

  // Project hierarchy is enforced by the real Data API.
  const peerRemoval = await adminA.rpc('remove_project_member', {
    p_project_id: projectId,
    p_user_id: identities['admin-b'].id,
  });
  assert.ok(peerRemoval.error, 'admin removed a peer admin');

  // Checklist overrides may raise/lower checklist rights, never project rights.
  await rpc(owner, 'set_task_member_override', { p_task_id: taskId, p_user_id: identities.member.id, p_role: 'admin' });
  assert.equal(await rpc(member, 'get_my_task_role', { p_task_id: taskId }), 'admin');
  await rpc(member, 'update_task_item', { p_task_item_id: itemId, p_title: 'Raised checklist role' });
  const memberStageEdit = await member.rpc('update_task', { p_task_id: taskId, p_title: 'Forbidden stage edit', p_description: null });
  assert.ok(memberStageEdit.error, 'checklist override escalated project-level stage rights');

  await rpc(owner, 'set_task_member_override', { p_task_id: taskId, p_user_id: identities['admin-a'].id, p_role: 'viewer' });
  const loweredChecklistWrite = await adminA.rpc('set_task_item_percentage', { p_task_item_id: itemId, p_percentage: 30 });
  assert.ok(loweredChecklistWrite.error, 'lowered checklist viewer changed progress');
  await rpc(adminA, 'update_task', { p_task_id: taskId, p_title: 'Project admin retained stage rights', p_description: 'After' });

  // Profiles have one canonical write path and metadata cannot roll it back.
  const canonicalProfile = await rpc(owner, 'update_my_profile', { p_display_name: 'Canonical Owner' });
  assert.equal(canonicalProfile.display_name, 'Canonical Owner');
  const metadataUpdate = await authAdmin.auth.admin.updateUserById(identities.owner.id, {
    user_metadata: { display_name: 'Metadata Replacement' },
  });
  if (metadataUpdate.error) throw metadataUpdate.error;
  const afterMetadata = await rpc(owner, 'get_my_profile');
  assert.equal(afterMetadata.display_name, 'Canonical Owner');
  const directProfile = await owner.from('profiles').update({ display_name: 'Direct Bypass' }).eq('id', identities.owner.id).select();
  assert.ok(directProfile.error, 'direct profile update bypass remained available');
  const ownProfileAudit = await owner.from('audit_log').select('id').eq('entity_type', 'profile').eq('entity_id', identities.owner.id);
  if (ownProfileAudit.error) throw ownProfileAudit.error;
  assert.ok(ownProfileAudit.data.length >= 1, 'user cannot see own profile audit');
  const foreignProfileAudit = await adminA.from('audit_log').select('id').eq('entity_type', 'profile').eq('entity_id', identities.owner.id);
  if (foreignProfileAudit.error) throw foreignProfileAudit.error;
  assert.equal(foreignProfileAudit.data.length, 0, 'project admin saw global profile history');

  // Limits are enforced through public mutation paths.
  const oversizedTitle = await owner.rpc('update_task', { p_task_id: taskId, p_title: 'T'.repeat(501), p_description: null });
  assert.ok(oversizedTitle.error, 'title >500 accepted');
  const oversizedComment = await owner.rpc('set_task_item_comment', { p_task_item_id: itemId, p_comment: 'C'.repeat(10_001) });
  assert.ok(oversizedComment.error, 'comment >10000 accepted');

  // service_role is Auth administration only, not an undocumented app CRUD/RPC API.
  const serviceRead = await service.from('projects').select('id').limit(1);
  assert.ok(serviceRead.error, 'service_role retained application table access');
  const serviceRpc = await service.rpc('list_task_templates');
  assert.ok(serviceRpc.error, 'service_role retained application RPC access');

  // Real private Broadcast: member receives a minimal tenant event; outsider cannot join.
  const projectChannel = member.channel(`project:${projectId}`, { config: { private: true } });
  const projectEvent = nextBroadcast(projectChannel, 'tasks');
  await subscribe(projectChannel, true);
  const outsiderChannel = outsider.channel(`project:${projectId}`, { config: { private: true } });
  await subscribe(outsiderChannel, false);
  await rpc(owner, 'update_task', { p_task_id: taskId, p_title: 'Broadcast update', p_description: 'minimal payload' });
  const projectPayload = await projectEvent;
  assertMinimalInvalidation(projectPayload, 'tasks', 'UPDATE');

  // Permission invalidation is delivered on the affected user's private topic.
  const userChannel = member.channel(`user:${identities.member.id}`, { config: { private: true } });
  await subscribe(userChannel, true);

  const projectListEvent = nextBroadcast(userChannel, 'projects');
  await rpc(owner, 'update_project', {
    p_project_id: projectId,
    p_name: `Backend integration updated ${nonce}`,
    p_description: 'User-topic project invalidation',
  });
  assertMinimalInvalidation(await projectListEvent, 'projects', 'UPDATE');

  await rpc(owner, 'add_task_assignee', { p_task_id: taskId, p_user_id: identities.member.id });
  const assignedTaskEvent = nextBroadcast(userChannel, 'tasks');
  await rpc(owner, 'update_task', {
    p_task_id: taskId,
    p_title: 'Assigned task invalidation',
    p_description: 'User-topic task invalidation',
  });
  assertMinimalInvalidation(await assignedTaskEvent, 'tasks', 'UPDATE');

  const permissionEvent = nextBroadcast(userChannel, 'task_members');
  await rpc(owner, 'set_task_member_override', { p_task_id: taskId, p_user_id: identities.member.id, p_role: 'viewer' });
  assertMinimalInvalidation(await permissionEvent, 'task_members', 'UPDATE');

  // The old Postgres Changes data plane is silent for application tables.
  const postgresChanges = owner.channel(`backend-postgres-changes-${nonce}`);
  await expectNoPostgresChange(postgresChanges, () => rpc(owner, 'update_task', {
    p_task_id: taskId,
    p_title: 'No Postgres Changes',
    p_description: 'Broadcast only',
  }));

  await Promise.all([
    member.removeChannel(projectChannel),
    outsider.removeChannel(outsiderChannel),
    member.removeChannel(userChannel),
    owner.removeChannel(postgresChanges),
  ]);

  console.log('Backend Data API/Auth/Realtime integration tests passed.');
} finally {
  if (projectId) {
    await Promise.resolve(owner.rpc('archive_project', { p_project_id: projectId })).catch(() => undefined);
    await Promise.resolve(owner.rpc('hard_delete_project', { p_project_id: projectId })).catch(() => undefined);
  }
  await Promise.all(clients.map(async (client) => {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    client.realtime.disconnect();
  }));
}
