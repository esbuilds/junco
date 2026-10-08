import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The AG Studio licence key is read at build/dev time from the env or from the .env in JUNCO_ENV_DIR
// (the main checkout). It is never written to a tracked file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.env.JUNCO_ENV_DIR ?? '..', '');
  return {
    plugins: [react()],
    define: { __AG_STUDIO_KEY__: JSON.stringify(env.AG_STUDIO_LICENSE_KEY ?? '') },
    server: {
      port: 5173,
      // The desk server (src/desk.ts) sends no CORS headers, so the studio reaches it through this proxy.
      proxy: { '/api': { target: env.DESK_URL ?? 'http://localhost:3000', changeOrigin: true } },
    },
  };
});
