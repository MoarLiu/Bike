import assert from "node:assert/strict";
import test from "node:test";

test("server module can be imported without starting stdio", async () => {
  const module = await import("./bike-server.mjs");
  assert.equal(typeof module.createBikeMcpServer, "function");
});
