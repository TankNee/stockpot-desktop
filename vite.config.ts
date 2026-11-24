import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

// The Tauri dev server port. It defaults to 1700, but Windows reserves some
// port ranges for Hyper-V/WSL (1420 and 1406-1505 both fail with `EACCES`), so
// the default avoids them. Set STOCKPOT_DEV_PORT to move it; tauri.conf.json's
// `devUrl` must match, so change both together.
const port = Number(process.env.STOCKPOT_DEV_PORT) || 1700;

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        settings: path.resolve(__dirname, "settings.html"),
      },
    },
  },
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: port + 1 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
