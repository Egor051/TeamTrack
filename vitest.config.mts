import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The four-worker cap must also respect CPU affinity/runner capacity. Four
  // workers on two available CPUs reproduced the bootstrap deadline failure.
  test: { environment: 'node', maxWorkers: Math.min(4, availableParallelism()), setupFiles: ['./tests/setup-connectivity.ts'] },
});
