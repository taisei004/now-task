import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig({
  plugins: [
    react(),
    cloudflare({ remoteBindings: process.env.CF_REMOTE_BINDINGS === "true" }),
  ],
  server: { port: 5173 },
});
