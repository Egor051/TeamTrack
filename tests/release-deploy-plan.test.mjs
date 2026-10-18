import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const forward = readdirSync(join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')&&f>='20261016191158_').sort();
const baseline = () => forward.slice(0,8).map((file,index)=>({version:'20261017000'+String(400+index).padStart(3,'0'),name:file.slice(15,-4),statements:[readFileSync(join(root,'supabase/migrations',file),'utf8')]}));
function run(change = rows => rows) {
  const directory=mkdtempSync(join(tmpdir(),'tasktrace-plan-'));
  const history=join(directory,'history.json'),destination=join(directory,'plan');
  writeFileSync(history,JSON.stringify(change(baseline())));
  const result=spawnSync(process.execPath,['scripts/prepare-security-deploy-plan.mjs',history,destination],{cwd:root,encoding:'utf8'});
  return {directory,destination,result};
}
describe('release deployment lineage',()=>{
  it('recognizes identical source under hosted timestamps and includes every unapplied forward file exactly once',()=>{
    const {directory,destination,result}=run();
    try{
      expect(result.status).toBe(0);
      const plan=JSON.parse(readFileSync(join(destination,'manifest.json'),'utf8'));
      expect(plan.pending.map(row=>row.file)).toEqual(forward.slice(8));
      expect(plan.required_pending_count).toBe(forward.length-8);
      expect(plan.already_applied_forward).toHaveLength(8);
      expect(plan.production_applied).toBe(false);
      expect(readdirSync(join(destination,'supabase/migrations'))).toHaveLength(forward.length);
    }finally{rmSync(directory,{recursive:true});}
  });
  it.each(['source','duplicate'])('fails closed for %s drift instead of silently classifying it as applied',kind=>{
    const {directory,result}=run(rows=>kind==='source'?rows.map((row,index)=>index?row:{...row,statements:['select 1;']}):[...rows,rows[0]]);
    try{expect(result.status).not.toBe(0);expect(result.stderr).toMatch(/source drift|Unexpected hosted history/);}finally{rmSync(directory,{recursive:true});}
  });
});
