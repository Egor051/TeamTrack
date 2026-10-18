import { readdirSync } from 'node:fs';

export function sqlTestSuites(directory, { fresh = false, requested = [] } = {}) {
  const all = readdirSync(directory).filter((name) => name.endsWith('_test.sql')).sort();
  const upgradeOnly = ['audit_upgrade_test.sql', 'audit_template_ordering_test.sql'];
  // This file contains manual two-session instructions, not an executable suite.
  // CI requires run-security-integrations -> run-concurrency-tests.mjs instead.
  const manual = 'concurrency_test.sql';
  const excluded = [manual, ...(fresh ? upgradeOnly : [])];
  for (const name of requested) {
    if (!all.includes(name) || excluded.includes(name)) throw new Error(`SQL suite unavailable in this mode: ${name}`);
  }
  return { suites: requested.length ? requested : all.filter((name) => !excluded.includes(name)),
    notApplicable: fresh ? upgradeOnly : [], manual };
}
