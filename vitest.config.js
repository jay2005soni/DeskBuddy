import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { maxWorkers: 1, minWorkers: 1, fileParallelism: false, testTimeout: 15000, hookTimeout: 60000 },
});
