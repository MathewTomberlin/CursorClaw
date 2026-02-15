import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html"
    }
  },
  server: {
    proxy: {
      "/rpc": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/status": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/stream": { target: "http://127.0.0.1:8787", changeOrigin: true, ws: true }
    }
  }
});
