import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { asUser, createSecurityDatabase } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';

// Execute the actual client paginator without Metro or a second implementation.
const source = readFileSync(new URL('../src/features/projects/template-pages.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { readTemplatePages } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const env = await createSecurityDatabase();
let api;
try {
  api = await startSecurityApi(env);
  const owner = randomUUID(), outsider = randomUUID();
  await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"display_name\":\"Remediation Owner\"}'),($3,$4,'{\"display_name\":\"Remediation Outsider\"}')",
    [owner,owner+'@test.local',outsider,outsider+'@test.local']);
  const client = api.client(owner);
  const rpc = async (name, args) => { const response = await client.rpc(name,args); if (response.error) throw response.error; return response.data; };
  const pageRequest = (template) => (offset,limit,revision) => client.rpc('get_task_template_page', {
    p_template_id: template, p_offset: offset, p_limit: limit, p_revision: revision,
  });
  const project = await rpc('create_project',{p_name:'Remediation integration'});
  // Empty catalog, then grow it through every API boundary.
  let previous = 0;
  for (const count of [0,1,999,1000,1001,2001,5001]) {
    await env.db.query(`insert into public.task_templates(name,created_by,created_at)
      select 'Catalog '||n,$1,'2026-01-01'::timestamptz from generate_series($2::integer+1,$3::integer) n`,[owner,previous,count]);
    const started = performance.now();
    const rows = await readTemplatePages(pageRequest(null));
    assert.equal(rows.length,count); assert.equal(new Set(rows.map(r=>r.id)).size,count);
    assert.deepEqual(rows.map(r=>r.id),rows.map(r=>r.id).sort()); // all timestamps deliberately tie
    console.log(`PASS B03 catalog ${count}: ${Math.round(performance.now()-started)}ms`);
    if (count===1001) assert.equal((await rpc('list_task_templates')).length,1000,'real PostgREST cap must reproduce the original truncation');
    previous=count;
  }
  const template = await rpc('create_task_template',{p_name:'Large template'});
  previous=0;
  for (const count of [0,1,999,1000,1001,2001,5001]) {
    await env.db.query(`insert into public.task_template_items(template_id,title,description,position,created_at)
      select $1,'Item '||n,'Description '||n,n,'2026-01-01'::timestamptz from generate_series($2::integer+1,$3::integer) n`,[template,previous,count]);
    const started=performance.now();
    const rows=await readTemplatePages(pageRequest(template));
    assert.equal(rows.length,count); assert.equal(new Set(rows.map(r=>r.id)).size,count);
    assert.deepEqual(rows.map(r=>r.title),Array.from({length:count},(_,n)=>'Item '+(n+1)));
    const preview=await rpc('get_task_template',{p_template_id:template});
    assert.deepEqual(preview.items.map(r=>r.id),rows.map(r=>r.id));
    if (count===1001) assert.equal((await rpc('list_task_template_items',{p_template_id:template})).length,1000);
    console.log(`PASS B03 items/preview ${count}: ${Math.round(performance.now()-started)}ms`);
    previous=count;
  }
  const first=await rpc('get_task_template_page',{p_template_id:template});
  await rpc('create_task_template_item',{p_template_id:template,p_title:'Concurrent insert'});
  const stale=await client.rpc('get_task_template_page',{p_template_id:template,p_offset:500,p_revision:first.revision});
  assert.equal(stale.error?.code,'PT409');
  let changed=false;
  const consistent=await readTemplatePages(async (offset,limit,revision)=>{
    if(offset===500&&!changed){changed=true;await env.db.query('delete from public.task_template_items where template_id=$1 and position=250',[template]);}
    return pageRequest(template)(offset,limit,revision);
  });
  assert.equal(consistent.length,5001); assert(!consistent.some(row=>row.title==='Item 250'));
  const task=await rpc('create_task_from_template',{p_project_id:project,p_template_id:template});
  const copied=(await env.db.query('select title,description,position from public.task_items where task_id=$1 order by position,id',[task])).rows;
  assert.deepEqual(copied.map(r=>[r.title,r.description]),consistent.map(r=>[r.title,r.description]));
  assert.deepEqual(copied.map(r=>Number(r.position)),Array.from({length:5001},(_,n)=>n+1));
  assert((await api.client(null,'anon').rpc('get_task_template_page')).error,'anon page access denied');
  assert((await api.client(outsider).rpc('update_task_template',{p_template_id:template,p_name:'Denied',p_description:'',p_expected_name:'Large template',p_expected_description:''})).error);
  // Two real HTTP saves starting from the same snapshot: exactly one wins.
  const saves=await Promise.all(['A','B'].map(p_name=>client.rpc('update_project',{p_project_id:project,p_name,p_description:'',p_expected_name:'Remediation integration',p_expected_description:''})));
  assert.equal(saves.filter(r=>!r.error).length,1); assert.equal(saves.filter(r=>r.error?.code==='PT409').length,1);
  await assert.rejects(asUser(env.db,outsider,()=>env.db.query('select public.update_project($1,$2,$3,$4,$5)',[project,'Denied','','A',''])),{code:'42501'});
  console.log('PASS B01/B03 real Data API: cap reproduction, consistent restart, full editor/preview/copy, ACL and concurrent CAS');
} finally { api?.close(); await env.close(); }
