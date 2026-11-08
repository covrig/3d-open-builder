// vitest/config re-exports Vite's defineConfig with the `test` section typed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths: the build works at covrig.github.io/3d-open-builder/
  // or any other sub-path without hard-coding the repo name.
  base: './',
  build: {
    // Top-level await is used to load the Manifold WASM module before the UI starts.
    target: 'es2022',
  },
  // The geometry worker is an ES module (it imports the Manifold WASM loader).
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Pre-bundling would break manifold-3d's WASM loading.
    exclude: ['manifold-3d'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
