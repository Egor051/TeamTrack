import { describe, expect, it } from 'vitest';
import { assertTypeGenerationDatabaseUrl, classifyDatabaseUrl } from '../scripts/db-url-policy.mjs';

describe('database connection policy', () => {
  it('recognizes the linked Supavisor session endpoint', () => {
    const result = classifyDatabaseUrl('postgresql://postgres.project:password@aws-0-eu-central-1.pooler.supabase.com:5432/postgres');
    expect(result.kind).toBe('hosted-pooler');
    expect(result.mode).toBe('session');
  });
  it('rejects a hosted direct endpoint for type generation', () => {
    expect(() => assertTypeGenerationDatabaseUrl('postgresql://postgres:password@db.project.supabase.co:5432/postgres')).toThrow(/hosted direct/);
  });
  it('allows the local direct endpoint used by the SQL toolchain', () => {
    expect(assertTypeGenerationDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres').kind).toBe('local-direct');
  });
  it('rejects transaction mode for CLI type generation', () => {
    expect(() => assertTypeGenerationDatabaseUrl('postgresql://postgres.project:password@aws-0-eu-central-1.pooler.supabase.com:6543/postgres')).toThrow(/session mode/);
  });
});
