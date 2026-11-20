// FILE: web/vite.config.ts
// Build and dev-server configuration for the frontend.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Forwards API calls to the local Worker so the browser sees a single origin, as in production.
    proxy: { "/api": "http://localhost:8787" },
  },
});
