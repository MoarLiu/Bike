import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  base: "./",
  plugins: [react(), {
    name: "production-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: {
      "http-equiv": "Content-Security-Policy",
      content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http: https:; object-src 'none'; base-uri 'self'; frame-src 'none'; form-action 'self'",
    }, injectTo: "head-prepend" }],
  }],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __RELEASE_PAGE_URL__: JSON.stringify("https://github.com/MoarLiu/Bike/releases"),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    target: "es2020",
  },
});
