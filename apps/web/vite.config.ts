import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";

// Vite config for @workspace/web.
//
// Dev-time proxy: the SPA talks to apps/api's GraphQL endpoint via a same-origin
// `/graphql` path so the browser never has to deal with CORS during local dev.
// The actual API/WS origins are also exposed as env vars (VITE_API_URL /
// VITE_WS_URL) for use at runtime by src/lib/api.ts and the collab features,
// since the proxy only exists in the Vite dev server, not in production
// (production nginx build talks directly to whatever VITE_API_URL/VITE_WS_URL
// point at - see Dockerfile / nginx.conf).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiUrl = env.VITE_API_URL || "http://localhost:4000";
  const wsUrl = env.VITE_WS_URL || "ws://localhost:1234";

  return {
    plugins: [solid()],
    server: {
      port: 5173,
      proxy: {
        "/graphql": {
          target: apiUrl,
          changeOrigin: true,
          ws: false,
        },
      },
    },
    define: {
      // Fallback constants in case env vars aren't picked up by consuming code
      // directly via import.meta.env (kept for symmetry/documentation only).
      __DEFAULT_API_URL__: JSON.stringify(apiUrl),
      __DEFAULT_WS_URL__: JSON.stringify(wsUrl),
    },
  };
});
