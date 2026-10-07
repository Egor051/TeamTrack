// Pure model serialization comparison. No database, auth, or Git writes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const ref = process.argv[2] ?? 'HEAD';
const sourcePath = 'src/lib/local-cache/bootstrap-models.ts';
const load = (source) => {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, Date, require: (name) => {
    if (name === './types') return { LOCAL_CACHE_SCHEMA_VERSION: 1 };
    if (name === '@/features/projects/task-audit') return { taskAuditEntityIds: (task, ids) => [task, ...ids] };
    throw new Error(`Unexpected runtime dependency: ${name}`);
  } });
  return exports.accountReadModels;
};
const before = load(execFileSync('git', ['show', `${ref}:${sourcePath}`], { cwd: root, encoding: 'utf8' }));
const after = load(readFileSync(resolve(root, sourcePath), 'utf8'));
const stamp = new Date().toISOString();
const profile = { id: 'user', display_name: 'Storage fixture' };
const rows = { profile: [profile], profiles: [profile], projects: [{ id: 'project', name: 'Fixture', role: 'owner', status: 'active', created_at: stamp }],
  tasks: [{ id: 'task', project_id: 'project', title: 'Stage', position: 1, created_at: stamp, status: 'in_progress' }], roles: [{ task_id: 'task', role: 'owner' }],
  members: [{ project_id: 'project', user_id: 'user', role: 'owner' }], assignees: [], overrides: [], daily_audit: [], templates: [], template_items: [],
  items: Array.from({ length: 1001 }, (_, i) => ({ id: `item-${i}`, task_id: 'task', title: 'Item', position: i, comment: 'Representative comment '.repeat(30),
    percentage: 40, is_completed: false, is_archived: i % 10 === 0, sync_version: 4 })) };
const measure = (fn) => {
  const entries = fn('user', rows, { day_start: stamp }, []);
  const items = entries.filter((entry) => entry.key.startsWith('items:'));
  const bytes = (values) => values.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0);
  return { records: entries.length, bytes: bytes(entries), itemRecords: items.length, itemBytes: bytes(items) };
};
const report = { environment: 'Pure accountReadModels serializers, identical 1001-item fixture, 690-byte comments, 10 percent archived',
  baseline: execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim(), before: measure(before), after: measure(after) };
mkdirSync(resolve(root, '.expo'), { recursive: true });
writeFileSync(resolve(root, '.expo/cache-model-storage.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
