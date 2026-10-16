import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { localDbBridge } from './local-db-bridge.mjs';
export const root=resolve(import.meta.dirname,'..');
export function docker(args,input){
 const r=spawnSync('docker',args,{cwd:root,input,encoding:'utf8',maxBuffer:30*1024*1024});
 if(r.error)throw r.error;
 if(r.status!==0)throw Error(r.stderr||r.stdout||'Docker failed');
 return r.stdout.trim();
}
export function connect(port,database,application_name='security_audit'){
 if(!/^teamtrack_audit_\d+$/.test(database)||!Number.isInteger(port))throw Error('Isolated local database required');
 return new pg.Client({host:'127.0.0.1',port,database,user:'supabase_admin',password:'postgres',application_name,statement_timeout:15000});
}
export function securityDatabaseContainers(){
 const containers=docker(['ps','--filter','name=supabase_db_','--format','{{.Names}}']).split(/\r?\n/).filter(Boolean);
 if(containers.length!==1)throw Error('Expected exactly one already running LOCAL Supabase database');
 const providerContainer=containers[0],container=process.env.TASKTRACE_SECURITY_POSTGRES_CONTAINER||providerContainer;
 if(container!==providerContainer&&!/^tasktrace-security-postgres-\d+$/.test(container))throw Error('Only a disposable security Postgres container can override the local database');
 return {container,providerContainer};
}
export async function createSecurityDatabase({baselineOnly=false}={}){
 const {container,providerContainer}=securityDatabaseContainers(),database='teamtrack_audit_'+process.pid;
 const sql=(source,db=database)=>{
  if(db!=='postgres'&&!/^teamtrack_audit_\d+$/.test(db))throw Error('Unsafe database target');
  return docker(['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d',db],source);
 };
 let bridge,created=false;
 try{
  const base=docker(['exec',providerContainer,'pg_dump','-U','postgres','-d','postgres','--schema-only','--no-owner','--no-privileges','--schema=auth','--schema=realtime'])
   .replace(/^CREATE TRIGGER[^\n]*EXECUTE FUNCTION (?:private|public)\.[^\n]*;\r?\n/gm,'')
   .replace(/^CREATE POLICY tasktrace_broadcast_read[^\n]*;\r?\n/gm,'');
  sql('create database '+database+' owner postgres;','postgres');created=true;
  sql(base);
  sql('grant usage,create on schema public to postgres; create schema extensions authorization postgres; create extension pgcrypto with schema extensions; create publication supabase_realtime; grant usage on schema auth,realtime to authenticated,anon,postgres; grant execute on all functions in schema auth,realtime to authenticated,anon,postgres; grant all on all tables in schema auth,realtime to postgres; grant all on all sequences in schema auth,realtime to postgres;');
  const migrations=readdirSync(resolve(root,'supabase/migrations')).filter(n=>n.endsWith('.sql')&&(!baselineOnly||n<'20261016191158_')).sort();
  for(const file of migrations)sql('set role postgres; set search_path=public,extensions;\n'+readFileSync(resolve(root,'supabase/migrations',file),'utf8'));
  bridge=localDbBridge(container);
  const db=connect(bridge.port,database);await db.connect();
  const close=async()=>{await db.end().catch(()=>undefined);bridge?.close();if(created){sql('drop database '+database+' with(force);','postgres');created=false;}};
  return {database,container,providerContainer,sql,db,port:bridge.port,close,migrations,base};
 }catch(error){bridge?.close();if(created)sql('drop database '+database+' with(force);','postgres');throw error;}
}
export async function asUser(db,userId,callback){
 await db.query('begin');
 try{await db.query('set local role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,true)",[userId]);const r=await callback();await db.query('commit');return r;}
 catch(error){await db.query('rollback');throw error;}
}
export function normalizedSnapshot(snapshot){
 const normalizeSql=s=>(s?.match(/'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\/|[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|::|<>|!=|>=|<=|\|\||[^\s]/gi)||[])
  .filter(t=>!t.startsWith('--')&&!t.startsWith('/*')).map(t=>t.startsWith("'")?t:t.toLowerCase()).join(' ').replace(/ ;$/,'');
 const result=structuredClone(snapshot);
 for(const rows of Object.values(result))for(const row of rows||[]){
  if(row.definition)row.definition=normalizeSql(row.definition.replace(/;\s*(\$[a-zA-Z0-9_]*\$)\s*$/,' $1'));
  if(row.default)row.default=normalizeSql(row.default);
  if(row.acl)row.acl=row.acl.slice(1,-1).split(',').sort().join(',');
  // pg_dump omits ACLs equal to acldefault(). A NULL relation ACL grants only
  // its owner; unlike a NULL FUNCTION ACL it never implies PUBLIC EXECUTE.
  if(row.kind&&row.acl===row.owner+'='+(row.kind==='S'?'rwU':'arwdDxtm')+'/'+row.owner)row.acl=null;
  if(row.name==='public'&&row.acl?.includes('=U/pg_database_owner'))
   row.acl=row.acl.split(',').filter(a=>! /^(postgres|anon|authenticated|service_role)=U\//.test(a)).join(',');
 }
 return result;
}
export function snapshotDiff(left,right){
 const a=normalizedSnapshot(left),b=normalizedSnapshot(right),diff={};
 const key=(row)=>[row.schema,row.table,row.name,row.arguments,row.kind,row.owner].filter(v=>v!==undefined).join('/');
 for(const collection of Object.keys(a)){
  const am=new Map((a[collection]||[]).map(r=>[key(r),r])),bm=new Map((b[collection]||[]).map(r=>[key(r),r]));
  const changes=[];
  for(const id of new Set([...am.keys(),...bm.keys()]))if(JSON.stringify(am.get(id))!==JSON.stringify(bm.get(id)))changes.push({id,left:am.get(id),right:bm.get(id)});
  if(changes.length)diff[collection]=changes;
 }
 return diff;
}
