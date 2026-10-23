import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Responses the browser keeps across reloads are discarded when the build changes (lib/persist.ts).
  define: { __YALD_BUILD__: JSON.stringify(`${version}+${Date.now().toString(36)}`) },
  server: {
    port: 5317,
    strictPort: false,
    proxy: {
      "/api": {
        target: process.env.OCX_API ?? "http://127.0.0.1:4318",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
