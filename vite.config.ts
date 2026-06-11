import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  base: "./",
  plugins: [react()],
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
