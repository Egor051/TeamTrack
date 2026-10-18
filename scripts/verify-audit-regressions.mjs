// Mutation checks in an isolated DB: regression SQL must reject the previous
// visibility function and succeed again after the remediation is reapplied.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSecurityDatabase, root } from './security-test-harness.mjs';
const env = await createSecurityDatabase();
try {
  const legacy = readFileSync(resolve(root,'supabase/migrations/20260927181857_implement_backend_remediation.sql'),'utf8');
  const start = legacy.indexOf('create or replace function private.audit_log_visible(');
  const stop = legacy.indexOf('\n$$;',start)+4;
  assert(start>=0 && stop>start);
  env.sql('set role postgres; '+legacy.slice(start,stop));
  const regression = readFileSync(resolve(root,'supabase/tests/audit_remediation_test.sql'),'utf8');
  assert.throws(() => env.sql(regression), /B04 role 3 sees 0 events/);
  const current = readFileSync(resolve(root,'supabase/migrations/20261017203226_audit_reliability_remediation.sql'),'utf8');
  const fixedStart=current.indexOf('create or replace function private.audit_log_visible(');
  const fixedStop=current.indexOf('end; $$;',fixedStart)+9;
  env.sql('set role postgres; '+current.slice(fixedStart,fixedStop));
  env.sql(regression);
  console.log('PASS B04 negative control: original RLS fails the regression; corrected RLS passes it');
  const templateRegression = readFileSync(resolve(root,'supabase/tests/template_realtime_test.sql'),'utf8');
  env.sql('set role postgres; drop trigger trg_task_templates_broadcast_invalidation on public.task_templates; drop trigger trg_task_template_items_broadcast_invalidation on public.task_template_items;');
  assert.throws(() => env.sql(templateRegression), /missing\/duplicate template signals/);
  env.sql('set role postgres; '+readFileSync(resolve(root,'supabase/migrations/20261018103053_template_realtime_invalidation.sql'),'utf8'));
  env.sql(templateRegression);
  console.log('PASS RA-04 negative control: missing Broadcast triggers fail the regression; the new migration restores it');
} finally { await env.close(); }
