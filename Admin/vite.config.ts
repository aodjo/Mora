import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/admin/",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/admin/api": "http://127.0.0.1:8787" } },
});
