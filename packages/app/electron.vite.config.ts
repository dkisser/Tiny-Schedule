import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  // @tiny-schedule/shared points at TypeScript sources, so it must be bundled
  // (Electron's Node cannot load .ts); externalizeDepsPlugin would otherwise
  // externalize it via the node_modules workspace symlink.
  main: { plugins: [externalizeDepsPlugin({ exclude: ['@tiny-schedule/shared'] })] },
  preload: { plugins: [externalizeDepsPlugin({ exclude: ['@tiny-schedule/shared'] })] },
  renderer: {
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)) },
    },
    plugins: [react(), tailwindcss()],
  },
});
