import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { requestJson } from "./network-proxy.cjs";

test("the Electron proxy deadline cancels a real HTTP body after headers arrived", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"unfinished":');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await assert.rejects(requestJson({ url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 50, maxBytes: 1024, requireJson: true }), (error) => error.code === "timeout");
});
