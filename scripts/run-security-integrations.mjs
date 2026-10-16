// Disposable Auth, PostgREST, Realtime and Mailpit against one isolated database.
// Existing local/hosted application data and configuration are never modified.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync,createWriteStream,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSecurityDatabase, docker, root } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';

const env = await createSecurityDatabase();
const suffix = String(process.pid);
const names = [];
const sockets = new Set();
const configPath = resolve(tmpdir(), 'tasktrace-isolated-security-' + suffix + '.json');
const evidence=process.env.TASKTRACE_SECURITY_EVIDENCE||root+'/.expo/security-evidence';mkdirSync(evidence,{recursive:true});
const results=[];
let api, proxy;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const inspect = (name) => JSON.parse(docker(['inspect', name]))[0].Config;
const vars = (cfg) => Object.fromEntries(cfg.Env.map((s) => { const i=s.indexOf('='); return [s.slice(0,i),s.slice(i+1)]; }));
const mapped = (name, port) => Number(docker(['port', name, port + '/tcp']).match(/:(\d+)\s*$/m)?.[1]);
async function healthy(url, headers = {}) {
  for (let i=0; i<180; i++) {
    try { const r = await fetch(url, { headers }); if (r.ok) return; } catch { /* starting */ }
    await pause(200);
  }
  throw new Error('Isolated service startup timeout: ' + new URL(url).pathname);
}
async function runNode(script) {
  const logPath=resolve(evidence,script.split('/').at(-1).replace('.mjs','')+'-'+suffix+'.log');
  const log=createWriteStream(logPath),started=Date.now();
  let stdout='';
  try { await new Promise((resolveRun,reject) => {
    const child = spawn(process.execPath, [script], { cwd:root, env:{...process.env,TASKTRACE_ISOLATED_CONFIG:configPath}, windowsHide:true });
    child.stdout.on('data',chunk=>{log.write(chunk);process.stdout.write(chunk);stdout+=String(chunk);});
    child.stderr.on('data',chunk=>{log.write(chunk);process.stderr.write(chunk);});
    child.on('error',reject);
    child.on('exit',(code) => {
      results.push({script,exit_code:code,pass_markers:(stdout.match(/PASS|tests passed|smoke passed/g)||[]).length,elapsed_ms:Date.now()-started,log:logPath});
      writeFileSync(resolve(evidence,'integration-results-'+suffix+'.json'),JSON.stringify(results,null,2));
      code === 0 ? resolveRun() : reject(new Error(script + ' exited ' + code));
    });
  }); } finally { await new Promise(r=>log.end(r)); }
}
try {
  api = await startSecurityApi(env);
  const network = docker(['inspect',env.container,'--format','{{.HostConfig.NetworkMode}}']);
  const ref = (env.providerContainer??env.container).slice('supabase_db_'.length);
  const start = (name,image,variables,port) => {
    names.push(name);
    docker(['run','-d','--name',name,'--network',network,'-p','127.0.0.1::'+port,
      ...Object.entries(variables).flatMap(([k,v]) => ['-e',k+'='+v]),image]);
    return 'http://127.0.0.1:'+mapped(name,port);
  };
  const mailName = 'tasktrace-security-mail-' + suffix;
  const mailUrl = start(mailName, inspect('supabase_inbucket_'+ref).Image, {}, 8025);
  await healthy(mailUrl+'/api/v1/messages');
  const routes = {};
  const destination = (raw) => {
    for (const [prefix,endpoint] of Object.entries(routes)) if(raw.startsWith(prefix))
      return { url:new URL(endpoint+(raw.slice(prefix.length)||'/')), realtime:prefix==='/realtime/v1' };
    return null;
  };
  const headersFor = (req,target) => ({...req.headers,host:target.realtime?'realtime-dev.localhost':target.url.host});
  proxy = http.createServer((req,res) => {
    res.setHeader('Access-Control-Allow-Origin',req.headers.origin||'*');
    res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers']||'authorization,apikey,content-type,x-client-info,prefer,x-supabase-api-version,accept-profile,content-profile');
    res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers','content-range,retry-after');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const target=destination(req.url);
    if(!target){res.writeHead(404);res.end();return;}
    const upstream=http.request(target.url,{method:req.method,headers:headersFor(req,target)},(response)=>{
      for(const [key,value] of Object.entries(response.headers)) if(!key.startsWith('access-control-'))res.setHeader(key,value);
      res.writeHead(response.statusCode);response.pipe(res);
    });
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.pipe(upstream);
  });
  proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  proxy.on('upgrade',(req,socket,head)=>{
    const target=destination(req.url);
    if(!target?.realtime){socket.destroy();return;}
    const upstream=http.request(target.url,{headers:headersFor(req,target)});
    upstream.on('upgrade',(response,remote,remoteHead)=>{
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
      if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
      socket.pipe(remote).pipe(socket);socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
      socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());
    });
    upstream.on('response',response=>{socket.end('HTTP/1.1 '+response.statusCode+' Rejected\r\nConnection: close\r\n\r\n');});
    upstream.on('error',()=>socket.destroy());upstream.end();
  });
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+proxy.address().port;
  routes['/rest/v1']=api.url;
  // Copy provider migration VERSION metadata only, never users, tenants or data.
  env.sql(docker(['exec',env.providerContainer,'pg_dump','-U','postgres','-d','postgres','--data-only','--no-owner','--no-privileges','--table=auth.schema_migrations','--table=realtime.schema_migrations']));
  // Provider ACL from the source stack's catalog. Application RLS still decides
  // which private topics a user can read; no INSERT policy is introduced.
  env.sql('grant select,insert,update on realtime.messages to anon,authenticated,service_role;');
  const authConfig=inspect('supabase_auth_'+ref), auth=vars(authConfig);
  delete auth.GOTRUE_JWT_KEYS;
  Object.assign(auth,{
    GOTRUE_DB_DATABASE_URL:'postgresql://supabase_admin:postgres@'+env.container+':5432/'+env.database,
    API_EXTERNAL_URL:url,GOTRUE_JWT_SECRET:api.secret,GOTRUE_JWT_VALIDMETHODS:'HS256',GOTRUE_JWT_VALID_METHODS:'HS256',
    GOTRUE_JWT_ISSUER:url+'/auth/v1',GOTRUE_SMTP_HOST:mailName,GOTRUE_SMTP_PORT:'1025',
    GOTRUE_RATE_LIMIT_EMAIL_SENT:'1000',GOTRUE_SMTP_MAX_FREQUENCY:'1s'
  });
  for(const kind of ['CONFIRMATION','RECOVERY','INVITE','EMAIL_CHANGE'])auth['GOTRUE_MAILER_URLPATHS_'+kind]=url+'/auth/v1/verify';
  routes['/auth/v1']=start('tasktrace-security-auth-'+suffix,authConfig.Image,auth,9999);
  await healthy(routes['/auth/v1']+'/health');
  env.sql('create schema _realtime;');
  const rtConfig=inspect('supabase_realtime_'+ref), rt=vars(rtConfig);
  delete rt.API_JWT_JWKS;
  Object.assign(rt,{
    DB_NAME:env.database,DB_HOST:env.container,DB_PORT:'5432',DB_USER:'supabase_admin',DB_PASSWORD:'postgres',
    API_JWT_SECRET:api.secret,METRICS_JWT_SECRET:api.secret,SECRET_KEY_BASE:randomBytes(64).toString('hex'),
    DB_ENC_KEY:randomBytes(8).toString('hex'),SEED_SELF_HOST:'true',SELF_HOST_TENANT_NAME:'realtime-dev',
    SLOT_NAME_SUFFIX:'security_'+suffix,DNS_NODES:'',APP_NAME:'security_'+suffix
  });
  routes['/realtime/v1']=start('tasktrace-security-realtime-'+suffix,rtConfig.Image,rt,4000)+'/socket';
  // The seed eval briefly starts an HTTP endpoint too. Wait until run.sh has
  // finished seeding before probing the final server used by the tests.
  for(let i=0;i<180;i++){
    const log=spawnSync('docker',['logs','tasktrace-security-realtime-'+suffix],{encoding:'utf8'}).stdout;
    if(/\nStarting Realtime\r?\n/.test(log)){await pause(1500);break;}
    if(i===179)throw Error('Realtime seed did not finish');
    await pause(200);
  }
  await healthy(routes['/realtime/v1'].replace('/socket','')+'/api/tenants/realtime-dev/health', {Authorization:'Bearer '+api.token(null,'service_role')});
  const status={kind:'tasktrace-isolated-security-test',API_URL:url,
    DB_URL:'postgresql://supabase_admin:postgres@127.0.0.1:'+env.port+'/'+env.database,
    ANON_KEY:api.token(),SERVICE_ROLE_KEY:api.token(null,'service_role'),MAILPIT_URL:mailUrl};
  writeFileSync(configPath,JSON.stringify(status),{mode:0o600});
  console.log('PASS isolated Auth/PostgREST/Realtime/Mailpit startup; synthetic keys and accounts only');
  const requested=process.argv.slice(2);
  const scripts=requested.length?requested:[
    'scripts/run-backend-integration-tests.mjs','scripts/run-pkce-integration-tests.mjs',
    'scripts/run-concurrency-tests.mjs','scripts/run-bootstrap-integration-tests.mjs','scripts/password-auth-integration.mjs','scripts/security-realtime-lifecycle.mjs'
  ];
  for(const script of scripts) {
    if(!/^scripts\/[a-z0-9-]+\.mjs$/.test(script))throw Error('An explicit repository test script is required');
    await runNode(script);
  }
} catch (error) {
  for(const name of names.filter(n=>n.includes('realtime')||n.includes('auth'))) {
    const log=spawnSync('docker',['logs','--tail','150',name],{encoding:'utf8'});
    console.error((log.stdout+'\n'+log.stderr).split('\n').filter(line=>/error|warning|fatal/i.test(line)).join('\n')
      .replaceAll(api?.secret??'__absent__','[test secret]').replace(/eyJ[A-Za-z0-9_.-]+/g,'[test JWT]'));
  }
  throw error;
} finally {
  for(const socket of sockets)socket.destroy();
  if(proxy)await new Promise(r=>proxy.close(r));
  for(const name of names.reverse())spawnSync('docker',['rm','-f',name],{encoding:'utf8'});
  api?.close();
  try{unlinkSync(configPath);}catch{/* not created */}
  // Terminate only replication slots belonging to this disposable database.
  env.sql("select pg_terminate_backend(active_pid) from pg_replication_slots where database='"+env.database+"' and active_pid is not null;");
  env.sql("select pg_drop_replication_slot(slot_name) from pg_replication_slots where database='"+env.database+"' and not active;");
  await env.close();
}
