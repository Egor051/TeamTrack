import { describe,it,expect,vi } from 'vitest';
import { mapSupabaseAuthError,weakPasswordMessage } from '@/lib/errors/auth-errors';
import { userMessage } from '@/lib/errors/user-message';

describe('server password-security messages',()=>{
 it('explains a compromised password without echoing raw server text',()=>{
  expect(mapSupabaseAuthError({code:'weak_password',reasons:['pwned'],message:'internal secret'})).toContain('утечках');
  expect(mapSupabaseAuthError({code:'weak_password',reasons:['pwned'],message:'internal secret'})).not.toContain('secret');
 });
 it('gives compromise priority over simultaneous length and character warnings',()=>{
  expect(weakPasswordMessage({reasons:['length','characters','pwned']})).toContain('утечках');
 });
 it('supports the password response shape used by Auth',()=>{
  expect(weakPasswordMessage({weak_password:{reasons:['pwned']}})).toContain('утечках');
 });
 it.each([['length','короткий'],['characters','сложности']])('maps %s independently',(reason,text)=>{
  expect(weakPasswordMessage({reasons:[reason]})).toContain(text);
 });
 it.each([null,{}, {reasons:'pwned'},{reasons:['unknown']}])('keeps unknown/malformed reasons safe: %j',(value)=>{
  expect(weakPasswordMessage(value)).toContain('требованиям безопасности');
 });
 it('retains ordinary login and recovery error handling',()=>{
  expect(mapSupabaseAuthError({code:'invalid_login_credentials'})).toBe('Неверные учетные данные');
  expect(mapSupabaseAuthError({code:'invalid_reset_token'})).toContain('недействительна');
 });
 it('maps lookup denial without exposing whether an account exists',()=>{
  const quiet=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  try{
   expect(userMessage({code:'TT_MEMBER_LOOKUP',message:'private user lookup'},'fallback')).toBe('Не удалось добавить участника по указанному идентификатору.');
   expect(userMessage({code:'PT429'},'fallback')).toContain('через минуту');
  }finally{quiet.mockRestore();}
 });
});
