import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./main.cjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.cjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declarations = ast.statements.flatMap((item) => ts.isVariableStatement(item) ? [...item.declarationList.declarations] : []);
const callback = (name) => declarations.find((item) => item.name.getText(ast) === name).initializer.getText(ast);
const fixture = (choices) => {
  const dialogs = [];
  const calls = [];
  const service = {
    check: async () => ({ status: "available", currentVersion: "1.7.0", latestVersion: "1.7.1" }),
    download: async () => { calls.push("download"); return { status: "downloaded", latestVersion: "1.7.1" }; },
    install: async () => { calls.push("install"); return { status: "installing" }; },
  };
  const context = vm.createContext({
    updates: () => service, focusedAppWindow: () => ({}), app: { getVersion: () => "1.7.0" },
    showMessageBox: async (_window, options) => { dialogs.push(options); return { response: choices.shift() ?? 0 }; },
  });
  vm.runInContext(`let updateFlow; const runUpdateDialog = ${callback("runUpdateDialog")}; this.run = ${callback("showUpdateDialog")};`, context);
  return { run: context.run, service, calls, dialogs };
};

test("the application update flow downloads and then offers restart installation", async () => {
  const f = fixture([0, 0]);
  const result = await f.run();
  assert.equal(result.status, "installing");
  assert.deepEqual(f.calls, ["download", "install"]);
  assert.equal(f.dialogs[0].buttons[0], "下载更新");
  assert.equal(f.dialogs[1].buttons[0], "重启并安装");
});

test("deferring download or restart leaves the application running", async () => {
  const before = fixture([1]);
  assert.equal((await before.run()).status, "available");
  assert.deepEqual(before.calls, []);
  const after = fixture([0, 1]);
  assert.equal((await after.run()).status, "downloaded");
  assert.deepEqual(after.calls, ["download"]);
});

test("a failed download reports failure and never offers installation", async () => {
  const f = fixture([0, 0]);
  f.service.download = async () => ({ status: "error", error: "网络请求失败" });
  assert.equal((await f.run()).ok, false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.dialogs[1].message, "网络请求失败");
});
