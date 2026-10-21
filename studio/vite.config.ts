import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The AG Studio licence key: a built bundle carries none; the desk writes it into index.html at runtime from its own env
// (src/desk.ts), so a new key is an env change, not a rebuild. The dev server (vite, port 5173) reads it from the env or
// from the .env in JUNCO_ENV_DIR (the main checkout). It is never written to a tracked file.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.env.JUNCO_ENV_DIR ?? '..', '');
  return {
    plugins: [react()],
    define: { __AG_STUDIO_KEY__: JSON.stringify(command === 'serve' ? env.AG_STUDIO_LICENSE_KEY ?? '' : ''), __STUDIO_AI__: JSON.stringify(env.STUDIO_AI === '1') },
    server: {
      port: 5173,
      // The desk server (src/desk.ts) sends no CORS headers, so the studio reaches it through this proxy.
      proxy: { '/api': { target: env.DESK_URL ?? 'http://localhost:3000', changeOrigin: true } },
    },
  };
});
