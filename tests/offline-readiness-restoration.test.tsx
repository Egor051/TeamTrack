import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initialBootstrap, type BootstrapMetadata } from '@/lib/local-cache/bootstrap-types';
const f = vi.hoisted(() => ({ user: 'a', metadata: vi.fn(), changed: null as null | ((id: string) => void) }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ state: { user: { id: f.user }, isLoading: false } }) }));
vi.mock('@/lib/local-cache/bootstrap', () => ({ getBootstrapMetadata: f.metadata,
  subscribeBootstrap: (callback: (id: string) => void) => { f.changed = callback; return () => { f.changed = null; }; } }));
import { useOfflineBootstrap } from '@/lib/local-cache/use-offline-bootstrap';
let renderer: ReactTestRenderer;
function Readiness() { return createElement('Readiness', {}, JSON.stringify(useOfflineBootstrap())); }
beforeEach(() => { vi.clearAllMocks(); f.user = 'a'; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(async () => { await act(async () => { renderer?.unmount(); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('remount and account switch show checking rather than a fictional unprepared cache, and ignore obsolete reads', async () => {
  let resolve!: (value: BootstrapMetadata) => void;
  f.metadata.mockImplementation(() => new Promise<BootstrapMetadata>((done) => { resolve = done; }));
  await act(async () => { renderer = create(createElement(Readiness)); });
  expect(JSON.stringify(renderer.toJSON())).toContain('checking');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('not_started');
  const value = { ...initialBootstrap('a'), status: 'ready' as const, basic_ready: true, offline_ready: true };
  await act(async () => { resolve(value); });
  expect(JSON.stringify(renderer.toJSON())).toContain('ready');
  await act(async () => { renderer.unmount(); renderer = create(createElement(Readiness)); });
  expect(JSON.stringify(renderer.toJSON())).toContain('checking'); const old = resolve;
  f.user = 'b'; await act(async () => { renderer.update(createElement(Readiness)); });
  await act(async () => { old(value); });
  expect(JSON.stringify(renderer.toJSON())).toContain('checking'); expect(JSON.stringify(renderer.toJSON())).toContain('b');
  await act(async () => { resolve({ ...value, user_id: 'b' }); });
  expect(JSON.stringify(renderer.toJSON())).toContain('ready');
});
