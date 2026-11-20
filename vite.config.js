import { defineConfig } from 'vite';

// Relative base so the build runs from any path (GitHub Pages project sites, subfolders, file hosts).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1600 },
});
