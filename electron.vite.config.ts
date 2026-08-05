import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const shared = resolve('src/shared');

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: resolve('src/main/index.ts') },
    },
    resolve: { alias: { '@shared': shared } },
  },
  preload: {
    build: {
      rollupOptions: { input: resolve('src/preload/index.ts') },
    },
    resolve: { alias: { '@shared': shared } },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: { input: resolve('src/renderer/index.html') },
    },
    resolve: { alias: { '@shared': shared } },
    plugins: [react()],
  },
});
