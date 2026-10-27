import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import { DEFAULT_DEV_PROXY_TARGET } from './shared/deployment.js';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Keep the vanilla client in its own folder while allowing it to import the
// shared event/config modules. Socket.IO is proxied to Express in development.
// The proxy target comes from shared/deployment.js so it can never drift from
// the port the server actually binds when PORT is unset locally.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const gameServer = env.GAME_SERVER_URL || DEFAULT_DEV_PROXY_TARGET;

  return {
    root: resolve(projectRoot, 'client'),
    publicDir: resolve(projectRoot, 'public'),
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
      // Content-hashed output goes to /bundled/ so it can be cached forever,
      // while everything under /assets/ is a plain `public/` copy with a stable
      // name that must stay revalidating. Mixing the two under /assets/ meant a
      // cached response for an unhashed asset could outlive several deploys —
      // which is how a stale 404 for character.glb kept a browser broken.
      assetsDir: 'bundled',
      // Three.js is intentionally bundled with the game client; its compressed
      // transfer size is small, so keep the build output warning meaningful.
      chunkSizeWarningLimit: 700,
    },
  };
});
