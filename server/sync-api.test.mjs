import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { handleSyncApi, readJsonRequestBody } from "./sync-api.mjs";
import { createServer, request as httpRequest } from "node:http";

const fakeRequest = ({ method = "GET", url = "/", chunks = [] } = {}) => {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.destroyed = false;
  request.destroy = () => {
    request.destroyed = true;
  };
  setImmediate(() => {
    for (const chunk of chunks) {
      if (request.destroyed) return;
      request.emit("data", chunk);
    }
    if (!request.destroyed) request.emit("end");
  });
  return request;
};

const fakeResponse = () => {
  const response = { statusCode: 0, headers: {}, body: "" };
  response.writeHead = (statusCode, headers = {}) => {
    response.statusCode = statusCode;
    response.headers = headers;
  };
  response.end = (body = "") => {
    response.body = String(body);
  };
  return response;
};

test("request bodies keep multi-byte characters split across chunks", async () => {
  const payload = JSON.stringify({ title: "中文标题", note: "同步不应写坏汉字 🚲" });
  const bytes = Buffer.from(payload, "utf8");
  // Split in the middle of every multi-byte character.
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 1) chunks.push(bytes.subarray(index, index + 1));

  const body = await readJsonRequestBody(fakeRequest({ method: "PUT", chunks }), 1024);
  assert.deepEqual(body, JSON.parse(payload));
});

test("request body limit counts bytes, not characters", async () => {
  const payload = Buffer.from(JSON.stringify({ text: "汉".repeat(20) }), "utf8");
  assert.ok(payload.length > 40);
  await assert.rejects(
    readJsonRequestBody(fakeRequest({ method: "PUT", chunks: [payload] }), 40),
    /请求体超过/,
  );
});

test("real HTTP clients receive structured 413 for both declared and chunked oversize bodies", async (t) => {
  const server = createServer((request, response) => {
    void handleSyncApi(request, response, { sync: { maxBodyBytes: 64 } }, { putDocument: () => assert.fail("oversize body reached storage") });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  for (const headers of [{ "Content-Length": "1000" }, { "Transfer-Encoding": "chunked" }]) {
    const result = await new Promise((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port: server.address().port, path: "/api/documents/large", method: "PUT", headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      request.on("error", reject);
      request.end("x".repeat(1000));
    });
    assert.equal(result.status, 413);
    assert.equal(result.body.error, "payload_too_large");
    assert.equal(result.body.maxBytes, 64);
  }
});

test("malformed percent-encoding in the path is a 400, not a 500", async () => {
  const response = fakeResponse();
  await handleSyncApi(
    fakeRequest({ url: "/api/documents/%E0%A4%A" }),
    response,
    { sync: { maxBodyBytes: 1024 } },
    { getManifest: () => ({ documents: [] }) },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "invalid_request");
});
