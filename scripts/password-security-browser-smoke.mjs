// Real GoTrue weak-password success → rendered notice → real password change.
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { openSync,closeSync,readFileSync,unlinkSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { root } from './security-test-harness.mjs';
import { closeSmokeBrowser,stopSmokeServer } from './smoke-process-cleanup.mjs';

const local=getLocalSupabaseStatus();
if(local.kind!=='tasktrace-isolated-security-test')throw Error('Disposable stack required');
// Synchronous browser CLI calls can starve Node's idle-socket close events.
// Keep SDK verification independent of that test-driver connection pool.
const nodeFetch=(input,init={})=>{const headers=new Headers(init.headers);headers.set('Connection','close');return fetch(input,{...init,headers});};
const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:nodeFetch}});
const db=new pg.Client({connectionString:local.DB_URL});
const email='password-browser-'+Date.now()+'@security.test';
const name='password-security-'+process.pid,base='http://127.0.0.1:4176';
const out=process.env.TASKTRACE_SECURITY_EVIDENCE||root+'/.expo/security-evidence';mkdirSync(out,{recursive:true});
let server,id,browserStarted=false;
const cli=(...args)=>{
 browserStarted=true;
 const file=resolve(tmpdir(),'password-browser-'+process.pid+'-'+Date.now()+'.log'),fd=openSync(file,'w');
 try{
  const r=spawnSync(process.platform==='win32'?'cmd.exe':'npx',process.platform==='win32'?['/d','/s','/c','npx','--offline','--yes','agent-browser','--session',name,...args]:['--offline','--yes','agent-browser','--session',name,...args],
   {cwd:root,timeout:60000,windowsHide:true,stdio:['ignore',fd,fd]});
  const body=readFileSync(file,'utf8').trim();if(r.error||r.status)throw Error('Browser '+args[0]+': '+(r.error?.message||body));return body;
 }finally{closeSync(fd);try{unlinkSync(file);}catch{/* daemon log */}}
};
const body=()=>cli('get','text','body');
const ref=(snapshot,label)=>{
 const line=snapshot.split('\n').find(line=>line.includes(label)&&/ref=e\d+/.test(line));assert(line,'Missing control '+label+'\n'+snapshot);
 return '@'+line.match(/ref=(e\d+)/)[1];
};
async function until(probe,label){for(let i=0;i<35;i++){if(await probe())return;await new Promise(r=>setTimeout(r,200));}throw Error('Browser timeout: '+label);}
async function runBuild(){await new Promise((ok,no)=>{
 const p=spawn(process.execPath,['scripts/build-phase6-local-smoke.mjs'],{cwd:root,stdio:'inherit',windowsHide:true});
 p.once('error',no);p.once('exit',code=>code===0?ok():no(Error('Web export failed: '+code)));
});}
try{
 await runBuild();await db.connect();
 const created=await admin.auth.admin.createUser({email,password:'OriginalStrong9Z!',email_confirm:true,user_metadata:{display_name:'Проверка пароля'}});
 assert.equal(created.error,null);id=created.data.user.id;
 await db.query("update auth.users set encrypted_password=extensions.crypt('tiny',extensions.gen_salt('bf')) where id=$1",[id]);
 server=spawn(process.execPath,['scripts/serve-web.mjs'],{cwd:root,env:{...process.env,PORT:'4176'},stdio:'ignore',windowsHide:true});
 await until(async()=>{try{return(await fetch(base)).ok;}catch{return false;}},'static server');
 cli('set','viewport','320','900');cli('open',base+'/login');
 const login=cli('snapshot','-i');cli('fill',ref(login,'textbox "Email"'),email);cli('fill',ref(login,'textbox "Пароль"'),'tiny');cli('click',ref(login,'button "Войти"'));
 await until(()=>body().includes('Пароль слишком короткий.'),'server warning after successful login');
 assert(body().includes('Проекты'),'Weak-password warning replaced the authenticated app');
 for(const width of [320,390,768,1200]){
  cli('set','viewport',String(width),'900');assert.equal(cli('eval','document.documentElement.scrollWidth <= innerWidth'),'true');
 }
 cli('screenshot',resolve(out,'password-warning.png'));
 const notice=cli('snapshot','-i');cli('click',ref(notice,'Сменить пароль'));
 await until(()=>body().includes('Сохранить пароль'),'password change route');
 const reset=cli('snapshot','-i');cli('fill',ref(reset,'textbox "Новый пароль"'),'ChangedUnique9Z!');cli('fill',ref(reset,'textbox "Повторите пароль"'),'ChangedUnique9Z!');
 cli('click',ref(reset,'button "Сохранить пароль"'));
 await until(()=>body().includes('Проекты')&&!body().includes('Сохранить пароль'),'return after successful password update');
 assert(!body().includes('Пароль слишком короткий.'),'Successful update retained weak warning');
 const verifier=createClient(local.API_URL,local.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:nodeFetch}});
 assert.equal((await verifier.auth.signInWithPassword({email,password:'ChangedUnique9Z!'})).error,null);
 await verifier.auth.signOut({scope:'local'});verifier.realtime.disconnect();
 assert.equal(cli('errors'),'','Uncaught browser error');
 writeFileSync(resolve(out,'password-browser.json'),JSON.stringify({successful_legacy_signin_notice:true,authenticated_app_retained:true,widths:[320,390,768,1200],notice_link_opens_password_form:true,
  real_password_update:true,warning_cleared_after_success:true,new_password_signin:true,uncaught_browser_errors:0},null,2));
 console.log('PASS password browser: real weak-password login, authenticated warning at four widths, notice link, real update, warning removal and subsequent login');
}finally{
 if(browserStarted)try{closeSmokeBrowser(cli);}catch{/* server cleanup still required */}
 await stopSmokeServer(server);if(id)await admin.auth.admin.deleteUser(id);
 await db.end().catch(()=>undefined);admin.realtime.disconnect();
}
