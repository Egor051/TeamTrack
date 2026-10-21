import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Bound CPU/storage contention on Windows and the Node 22 CI workers. Keep
  // the same per-test deadlines and every storage/performance assertion.
  test: { environment: 'node', maxWorkers: 4, setupFiles: ['./tests/setup-connectivity.ts'] },
});
