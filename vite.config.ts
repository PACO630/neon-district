import { defineConfig } from 'vite';

// base './' makes the build work under any GitHub Pages sub-path (https://<user>.github.io/<repo>/)
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
  server: { host: true },
});
