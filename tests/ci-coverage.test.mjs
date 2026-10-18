import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sqlTestSuites } from '../scripts/sql-test-suites.mjs';
const root = resolve(import.meta.dirname, '..');
describe('P01 mandatory CI coverage', () => {
  it('discovers every executable SQL suite, including new files; classifies upgrade/manual cases explicitly', () => {
    const directory = join(root, 'supabase/tests');
    const plan = sqlTestSuites(directory);
    expect([...plan.suites, plan.manual].sort()).toEqual(readdirSync(directory).filter((name) => name.endsWith('_test.sql')).sort());
    const fresh = sqlTestSuites(directory, { fresh: true });
    expect([...fresh.suites, ...fresh.notApplicable].sort()).toEqual(plan.suites);
    const temporary = mkdtempSync(join(tmpdir(), 'tasktrace-ci-'));
    try {
      writeFileSync(join(temporary, 'future_regression_test.sql'), 'select 1;');
      expect(sqlTestSuites(temporary).suites).toEqual(['future_regression_test.sql']);
    } finally { rmSync(temporary, { recursive: true }); }
  });
  it('requires Vitest, fresh/upgrade, deadlines, RLS and real concurrency, without suppressing failures', () => {
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    for (const command of ['npm run test:unit','npm run test:sql -- --fresh','npm run test:sql -- --cron --advisors','npm run test:backend:isolated',
      'node scripts/run-audit-remediation-tests.mjs','npm run test:security',
      'node scripts/verify-audit-regressions.mjs','npx playwright install --with-deps chromium webkit',
      'node scripts/run-security-integrations.mjs scripts/audit-remediation-browser.mjs scripts/template-realtime-browser.mjs',
      'node scripts/pwa-mobile-browser-smoke.mjs','npx expo export --platform web --platform android --platform ios --source-maps --output-dir .expo/security-export',
      'node scripts/security-policy-gate.mjs --bundles .expo/security-export']) expect(workflow).toContain(`run: ${command}`);
    expect(workflow).not.toMatch(/continue-on-error|\|\| true/);
    expect(readFileSync(join(root,'scripts/run-security-integrations.mjs'),'utf8')).toContain('run-concurrency-tests.mjs');
    expect(readFileSync(join(root,'scripts/run-sql-tests.mjs'),'utf8')).not.toContain('db reset');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('supabase@2.116.0 stop --no-backup');
    expect(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).devDependencies.playwright).toBe('1.58.0');
    expect(workflow).toContain("if: always() && steps.dependencies.outcome == 'success'");
    expect(workflow).toContain('uses: actions/upload-artifact@v4');
    expect(workflow).toContain('path: .expo/security-policy/');
    expect(workflow).toContain('include-hidden-files: true');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).toContain("EXPO_NO_DOTENV: '1'");
    expect(workflow).not.toMatch(/secrets\.|pull_request_target|permissions:\s*write-all/);
  });
  it('exits nonzero for an unknown suite before creating a database', () => {
    const result = spawnSync(process.execPath, ['scripts/run-sql-tests.mjs','missing_test.sql'], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SQL suite unavailable');
  });
});
