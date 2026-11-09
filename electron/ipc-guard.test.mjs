import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedIpcSender, configuredNetworkRequest, safeReleaseUrl } from "./ipc-guard.cjs";

test("IPC requires the current window's main frame and trusted app URL", () => {
  const mainFrame = { routingId: 1, processId: 7, url: "file:///app/index.html" };
  const contents = { mainFrame, isDestroyed: () => false };
  const window = { webContents: contents };
  const allowed = (url) => url === mainFrame.url;
  assert.equal(isTrustedIpcSender({ sender: contents, senderFrame: mainFrame }, window, allowed), true);
  assert.equal(isTrustedIpcSender({ sender: contents, senderFrame: { ...mainFrame, routingId: 2 } }, window, allowed), false);
  assert.equal(isTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, window, allowed), false);
  assert.equal(isTrustedIpcSender({ sender: contents }, window, allowed), false);
  assert.equal(isTrustedIpcSender({ sender: contents, senderFrame: mainFrame }, window, () => false), false);
});

test("configured custom endpoints remain usable and mismatched destinations are refused", () => {
  const saved = { serverUrl: "http://private.example:8080/base/", token: "configured" };
  assert.equal(configuredNetworkRequest("sync", { serverUrl: "http://private.example:8080/base", token: "configured" }, saved), true);
  assert.throws(() => configuredNetworkRequest("sync", { serverUrl: "http://other.example", token: "configured" }, saved), /不一致/);
  assert.throws(() => configuredNetworkRequest("sync", { serverUrl: "file:///tmp/file", token: "configured" }, saved), /HTTP/);
});

test("release links stay on the owning project's GitHub HTTPS releases", () => {
  const expected = "https://github.com/MoarLiu/Bike/releases";
  assert.equal(safeReleaseUrl(`${expected}/tag/v1.6.1`), `${expected}/tag/v1.6.1`);
  for (const value of ["http://github.com/MoarLiu/Bike/releases", "https://github.com/other/repo/releases", "https://malicious.invalid", "javascript:alert(1)"]) assert.equal(safeReleaseUrl(value), expected);
});
