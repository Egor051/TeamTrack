import { expect, it } from 'vitest';
import { clientErrorDatabaseOptions } from '../supabase/functions/_shared/client-error-db-options';

it('requires verified TLS remotely even if the URL asks to disable SSL', () => {
  const options = clientErrorDatabaseOptions('postgres://user:private@db.example.invalid/db?sslmode=disable');
  expect(options.ssl).toEqual({ rejectUnauthorized: true });
  expect(options).toMatchObject({ max: 1, max_pipeline: 1, prepare: false, fetch_types: false });
});
it('accepts a server root certificate and permits plaintext only on loopback', () => {
  expect(clientErrorDatabaseOptions('postgres://user:private@db.example.invalid/db', 'test CA').ssl).toEqual({ rejectUnauthorized: true, ca: 'test CA' });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(clientErrorDatabaseOptions(`postgres://user:private@${host}/db`).ssl).toBe(false);
});
it('does not expose malformed credentials in configuration errors', () => {
  const secret = 'PRIVATE-SECRET-CANARY';
  expect(() => clientErrorDatabaseOptions(secret)).toThrow('Client diagnostic database connection is missing or invalid');
  try { clientErrorDatabaseOptions(secret); } catch (e) { expect(String(e)).not.toContain(secret); }
});
