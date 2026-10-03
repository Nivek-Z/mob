import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  environment: 'node', include: ['test/**/*.test.ts'], restoreMocks: true, fileParallelism: false,
  // Fail immediately if a future runtime test leaves a network body unread.
  env: { MINIFLARE_ASSERT_BODIES_CONSUMED: 'true' },
} });
