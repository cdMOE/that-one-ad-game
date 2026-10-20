import { defineConfig } from 'vitest/config';

// base './' keeps asset URLs relative, so the build works on GitHub Pages
// under any repository name (and on any other static host) without changes.
export default defineConfig({
  base: './',
  build: { target: 'es2022', sourcemap: true },
  server: { host: true },
  test: { include: ['tests/**/*.test.ts'] },
});
