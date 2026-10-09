import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Mirrors the renderer half of packages/app/electron.vite.config.ts, with the
// Tauri port baked in so `tauri dev` always finds a server on the expected URL.
// @tiny-schedule/shared points at TypeScript sources, so it is bundled like any
// other workspace source — no externals here, the webview has no Node loader.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  publicDir: fileURLToPath(new URL('../app/assets/renderer', import.meta.url)),
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // WKWebView on the macOS versions Tauri 2 supports.
    target: 'safari15',
    // Minify on. The renderer is the only bundle Tauri ships, so its size is
    // the install size; leaving it unminified cost ~3.5 MB of the entry chunk
    // (10.2 MB → 6.7 MB) for no benefit. Sourcemaps stay on so a stack trace
    // from a shipped build still points at real source.
    sourcemap: true,
  },
});
