import { defineConfig } from 'vite';

const host = process.env['TAURI_DEV_HOST'];
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host === undefined || host.length === 0 ? '0.0.0.0' : host,
    ...(host !== undefined && host.length > 0 ? { hmr: { protocol: 'ws', host, port: 1421 } } : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
