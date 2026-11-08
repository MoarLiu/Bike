import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { resolveDevServer } = require("./dev-server.cjs");

const builtRenderer = { isDev: false, url: null, origin: null, warning: null };

test("loads the built renderer for unpackaged runs without VITE_DEV_SERVER_URL", () => {
  assert.deepEqual(resolveDevServer({ env: {}, isPackaged: false }), builtRenderer);
  assert.deepEqual(
    resolveDevServer({ env: { VITE_DEV_SERVER_URL: "   " }, isPackaged: false }),
    builtRenderer,
  );
});

test("uses the configured dev server URL for unpackaged runs", () => {
  assert.deepEqual(
    resolveDevServer({
      env: { VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" },
      isPackaged: false,
    }),
    {
      isDev: true,
      url: "http://127.0.0.1:5173/",
      origin: "http://127.0.0.1:5173",
      warning: null,
    },
  );
});

test("keeps the host, port and path of a custom dev server URL", () => {
  const result = resolveDevServer({
    env: { VITE_DEV_SERVER_URL: " https://localhost:3000/app/ " },
    isPackaged: false,
  });

  assert.equal(result.isDev, true);
  assert.equal(result.url, "https://localhost:3000/app/");
  assert.equal(result.origin, "https://localhost:3000");
});

test("packaged builds ignore VITE_DEV_SERVER_URL", () => {
  for (const value of ["http://127.0.0.1:5173", "not a url"]) {
    assert.deepEqual(
      resolveDevServer({ env: { VITE_DEV_SERVER_URL: value }, isPackaged: true }),
      builtRenderer,
    );
  }
});

test("warns and loads the built renderer for invalid dev server URLs", () => {
  for (const value of [
    "127.0.0.1:5173",
    "localhost:5173",
    "not a url",
    "file:///tmp/index.html",
    "javascript:alert(1)",
  ]) {
    const result = resolveDevServer({
      env: { VITE_DEV_SERVER_URL: value },
      isPackaged: false,
    });

    assert.equal(result.isDev, false, value);
    assert.equal(result.url, null, value);
    assert.equal(result.origin, null, value);
    assert.match(result.warning, /^Ignoring VITE_DEV_SERVER_URL=.*dist\/index\.html/, value);
  }
});
