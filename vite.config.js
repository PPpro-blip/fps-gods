import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Keep the vanilla client in its own folder while allowing it to import the
// shared event/config modules. Socket.IO is proxied to Express in development.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const gameServer = env.GAME_SERVER_URL || 'http://127.0.0.1:3001';

  return {
    root: resolve(projectRoot, 'client'),
    envDir: projectRoot,
    server: {
      host: '0.0.0.0',
      port: Number(env.VITE_PORT) || 5173,
      strictPort: true,
      allowedHosts: true,
      fs: { allow: [projectRoot] },
      proxy: {
        '/socket.io': {
          target: gameServer,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      allowedHosts: true,
    },
    build: {
      outDir: resolve(projectRoot, 'dist/client'),
      emptyOutDir: true,
      // Three.js is intentionally bundled with the game client; its compressed
      // transfer size is small, so keep the build output warning meaningful.
      chunkSizeWarningLimit: 700,
    },
  };
});
