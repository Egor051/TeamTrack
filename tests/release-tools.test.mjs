import { expect,it } from 'vitest';
import { verifyReleaseAcceptance } from '../scripts/release-host-build.mjs';
import { manifest,maintenanceSql } from '../scripts/release-manifest.mjs';
import { comparePreflight } from '../scripts/release-preflight.mjs';
import { readFileSync } from 'node:fs';
import { sqlFunctionFingerprint } from '../scripts/release-sql-fingerprint.mjs';
const sha='a'.repeat(40),hash='b'.repeat(64);
const receipt=()=>({commit:sha,manifestSha256:hash,decision:'PASS',checks:{static:'success',database:'success',security:'success'},runUrl:'https://github.com/Egor051/TeamTrack/actions/runs/123'});
it('F07 hosting hold rejects a different commit, missing evidence and manifest drift',()=>{
 expect(()=>verifyReleaseAcceptance(receipt(),sha,hash)).not.toThrow();
 for(const value of [{...receipt(),commit:'c'.repeat(40)},{...receipt(),manifestSha256:'d'.repeat(64)},
  {...receipt(),decision:'FAIL'},undefined])expect(()=>verifyReleaseAcceptance(value,sha,hash)).toThrow();
});
it.each(['failure','skipped','cancelled',undefined])('F09 %s cannot become a successful release receipt',result=>{
 for(const name of ['static','database','security']) {
  const value=receipt();value.checks[name]=result;
  expect(()=>verifyReleaseAcceptance(value,sha,hash)).toThrow();
 }
});
it('F04/F08 exact six migration manifest and shared maintenance preflight are read-only generators',()=>{
 const value=manifest();expect(value.generalDbPushAllowed).toBe(false);expect(value.productionReady).toBe(false);
 expect(value.steps).toHaveLength(6);expect(new Set(value.steps.map(s=>s.sha256)).size).toBe(6);
 expect(maintenanceSql()).toContain('in share row exclusive mode');
 expect(maintenanceSql()).toContain('maintenance=true');
 expect(maintenanceSql()).not.toContain('configure_client_operation_release(');
});
it.each(['schemas','functions','tables','columns','policies','constraints','triggers','indexes','history'])('F08 unreviewed %s drift stops preflight',key=>{
 const expected=JSON.parse(readFileSync('docs/release/production-preconditions-2026-10-24.json','utf8'));
 const actual=structuredClone(expected);expect(()=>comparePreflight(actual,expected)).not.toThrow();
 actual[key].pop();expect(()=>comparePreflight(actual,expected)).toThrow(/STOP/);
});
it('F08 SQL fingerprint ignores formatting while preserving role literals and called functions',()=>{
 const fn=body=>'CREATE FUNCTION private.example() RETURNS boolean LANGUAGE sql AS $fn$'+body+'$fn$';
 const a=sqlFunctionFingerprint(fn("select role='owner'"));
 expect(sqlFunctionFingerprint(fn("\r\n SELECT role = 'owner'; \r\n"))).toBe(a);
 expect(sqlFunctionFingerprint(fn("select role='admin'"))).not.toBe(a);
 expect(sqlFunctionFingerprint(fn("select other_role='owner'"))).not.toBe(a);
 expect(sqlFunctionFingerprint(fn("select 'x\r\ny'"))).not.toBe(sqlFunctionFingerprint(fn("select 'x\ny'")));
});
