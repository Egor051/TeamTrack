import assert from 'node:assert/strict';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const local=getLocalSupabaseStatus();
if(local.kind!=='tasktrace-isolated-security-test')throw Error('The disposable security stack is required');
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,options);
const user=createClient(local.API_URL,local.ANON_KEY,options);
const db=new pg.Client({connectionString:local.DB_URL});
const email='password-security-'+Date.now()+'@security.test';
let id;
try{
 await db.connect();
 const created=await admin.auth.admin.createUser({email,password:'StrongLegacy9Z!',email_confirm:true});
 assert.equal(created.error,null);id=created.data.user.id;
 const signup=await user.auth.signUp({email:'rejected-'+email,password:'tiny'});
 assert.equal(signup.error?.code,'weak_password');assert(signup.error.reasons.includes('length'));
 // Reproduce an existing legacy password without weakening the Auth policy.
 await db.query("update auth.users set encrypted_password=extensions.crypt($1,extensions.gen_salt('bf')) where id=$2",['tiny',id]);
 const signed=await user.auth.signInWithPassword({email,password:'tiny'});
 assert.equal(signed.error,null);assert.equal(signed.data.user.id,id);assert(signed.data.session?.access_token);
 assert(signed.data.weakPassword?.reasons.includes('length'));
 const rejected=await user.auth.updateUser({password:'short'});
 assert.equal(rejected.error?.code,'weak_password');assert(rejected.error.reasons.includes('length'));
 assert.equal((await user.auth.getUser()).data.user.id,id,'rejected update invalidated the session');
 assert.equal((await user.auth.updateUser({password:'NewUniquePass9Z!'})).error,null);
 await user.auth.signOut({scope:'local'});
 const updated=await user.auth.signInWithPassword({email,password:'NewUniquePass9Z!'});
 assert.equal(updated.error,null);assert.equal(updated.data.weakPassword,undefined);
 const wrong=await user.auth.signInWithPassword({email,password:'WrongPass9Z!'});
 assert.equal(wrong.error?.code,'invalid_credentials');
 console.log('PASS real GoTrue: rejected weak signup/update, successful legacy login with weakPassword, retained session, strong update and subsequent login');
}finally{
 await user.auth.signOut({scope:'local'}).catch(()=>undefined);
 if(id)await admin.auth.admin.deleteUser(id);
 user.realtime.disconnect();admin.realtime.disconnect();await db.end();
}
