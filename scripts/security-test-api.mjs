import { createHmac,randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PostgrestClient } from '@supabase/postgrest-js';
import { Buffer } from 'node:buffer';
import { docker } from './security-test-harness.mjs';
export async function startSecurityApi(env){
 const secret=randomUUID()+randomUUID(),name='tasktrace-security-api-'+process.pid;
 const network=docker(['inspect',env.container,'--format','{{.HostConfig.NetworkMode}}']);
 const image=docker(['inspect',(env.providerContainer??env.container).replace('supabase_db_','supabase_rest_'),'--format','{{.Config.Image}}']);
 const token=(sub,role=sub?'authenticated':'anon')=>{
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({role,...(sub?{sub}:{}),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  return header+'.'+payload+'.'+createHmac('sha256',secret).update(header+'.'+payload).digest('base64url');
 };
 docker(['run','--rm','-d','--name',name,'--network',network,'-p','127.0.0.1::3000',
  '-e','PGRST_DB_URI=postgresql://supabase_admin:postgres@'+env.container+':5432/'+env.database,
  '-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e','PGRST_DB_TX_END=commit','-e','PGRST_DB_MAX_ROWS=1000',
  '-e','PGRST_JWT_SECRET='+secret,image]);
 const port=Number(docker(['port',name,'3000/tcp']).match(/:(\d+)\s*$/m)?.[1]);
 const url='http://127.0.0.1:'+port;
 try{for(let i=0;i<60;i++){try{if((await fetch(url)).ok)break;}catch{}if(i===59)throw Error('PostgREST startup timeout');await new Promise(r=>setTimeout(r,150));}}
 catch(error){spawnSync('docker',['rm','-f',name]);throw error;}
 const client=(sub,role)=>new PostgrestClient(url,{headers:sub||role?{Authorization:'Bearer '+token(sub,role)}:{}});
 return {url,token,client,secret,close(){spawnSync('docker',['rm','-f',name],{encoding:'utf8'});}};
}
