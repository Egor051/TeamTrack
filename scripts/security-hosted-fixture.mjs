import { readFileSync } from 'node:fs';
import { root } from './security-test-harness.mjs';

const ident=s=>'"'+s.replaceAll('"','""')+'"';
const permissions={r:'select',a:'insert',w:'update',d:'delete',D:'truncate',x:'references',t:'trigger',m:'maintain',U:'usage',X:'execute'};
function grants(acl,object){
 const result=[];
 for(const entry of acl?.slice(1,-1).split(',')||[]){
  const m=/^([^=]*)=([^/]*)\//.exec(entry);if(!m)throw Error('Unsupported fixture ACL');
  const grantee=m[1]||'public';
  if(grantee==='postgres'||grantee==='pg_database_owner')continue;
  if(!['public','anon','authenticated','service_role'].includes(grantee))throw Error('Unexpected fixture grantee');
  const privileges=[...m[2]].filter(c=>c!=='*').map(c=>permissions[c]);
  if(privileges.some(p=>!p))throw Error('Unknown fixture privilege');
  if(privileges.length)result.push('grant '+privileges.join(',')+' on '+object+' to '+grantee+';');
 }
 return result.join('\n');
}
/** Reconstruct the audited application-schema lineage without production data. */
export async function restoreHostedSecurityFixture(env,capturedPath=null){
 const hosted=JSON.parse(readFileSync(capturedPath||root+'/supabase/tests/fixtures/hosted_security_baseline_20261016.json','utf8')).snapshot;
 const current=(await env.db.query('set search_path=public,extensions;'+readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8'))).at(-1).rows[0].snapshot;
 const statements=['set role postgres; set search_path=public,extensions;'];
 // All captured CREATEs are application public/private functions; no data SQL.
 for(const f of hosted.functions){
  if(!['public','private'].includes(f.schema)||!f.definition.startsWith('CREATE OR REPLACE FUNCTION '))throw Error('Invalid function fixture');
  statements.push(f.definition+';');
  const object='function '+ident(f.schema)+'.'+ident(f.name)+'('+f.arguments.split(',').map(a=>a.trim().replace(/^\w+\s+/,'')).join(',')+')';
  statements.push('revoke all on '+object+' from public,anon,authenticated,service_role;',grants(f.acl,object));
 }
 for(const c of hosted.constraints){
  const old=current.constraints.find(x=>x.table===c.table&&x.name===c.name);
  if(old&&old.definition===c.definition&&old.deferrable===c.deferrable&&old.validated===c.validated)continue;
  const relation=c.table.split('.').map(ident).join('.');
  if(old)statements.push('alter table '+relation+' drop constraint '+ident(c.name)+';');
  statements.push('alter table '+relation+' add constraint '+ident(c.name)+' '+c.definition+';');
 }
 for(const index of current.indexes){
  if(!hosted.indexes.some(x=>x.table===index.table&&x.name===index.name)&&!current.constraints.some(c=>c.name===index.name))
   statements.push('drop index public.'+ident(index.name)+';');
 }
 for(const index of hosted.indexes)if(!current.indexes.some(x=>x.table===index.table&&x.name===index.name))
  statements.push(index.definition+';');
 for(const trigger of hosted.triggers){
  statements.push('drop trigger if exists '+ident(trigger.name)+' on '+trigger.table.split('.').map(ident).join('.')+';',trigger.definition+';');
 }
 for(const relation of hosted.tables){
  const object=(relation.kind==='S'?'sequence ':'table ')+ident(relation.schema)+'.'+ident(relation.name);
  statements.push('revoke all on '+object+' from public,anon,authenticated,service_role;',grants(relation.acl,object));
 }
 for(const schema of hosted.schemas){
  // Public USAGE is provider-owned; do not remove inherited defaults.
  if(schema.name==='public')statements.push('grant usage on schema public to postgres,anon,authenticated,service_role;');
 }
 if(capturedPath){
  // Reconstruct captured effective defaults; do not restore the older fixture's
  // intentionally broad historical defaults when testing today's deployment.
  for(const schema of ['public','private'])for(const object of ['tables','sequences','functions']){
   statements.push('alter default privileges for role postgres in schema '+ident(schema)+' revoke all on '+object+' from public,anon,authenticated,service_role;');
   const kind={tables:'r',sequences:'S',functions:'f'}[object];
   const row=hosted.defaults.find(r=>r.owner==='postgres'&&r.schema===schema&&r.kind===kind);
   if(row?.acl)for(const grant of grants(row.acl,object).split('\n').filter(Boolean))
    statements.push('alter default privileges for role postgres in schema '+ident(schema)+' '+grant);
  }
  statements.push('revoke create on schema public from postgres;');
 }else statements.push('alter default privileges for role postgres in schema public grant all on tables to anon,authenticated,service_role;',
  'alter default privileges for role postgres in schema public grant all on sequences to anon,authenticated,service_role;',
  'alter default privileges for role postgres in schema public grant execute on functions to anon,authenticated,service_role;');
 env.sql(statements.join('\n'));
 return hosted;
}
