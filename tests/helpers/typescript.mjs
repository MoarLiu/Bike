import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const cache = new Map();
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Run the actual browser modules in Node without emitting build files.
export function loadTypescript(filename) {
  const resolved = path.resolve(projectRoot, filename);
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const module = { exports: {} };
  cache.set(resolved, module);
  const require = createRequire(resolved);
  const code = compile(readFileSync(resolved, "utf8"));
  const execute = vm.runInThisContext(`(function(require, module, exports) {\n${code}\n})`, { filename: resolved });
  execute((name) => {
    if (name.endsWith("?url")) return name.slice(0, -4);
    if (!name.startsWith(".")) return require(name);
    const target = path.resolve(path.dirname(resolved), name);
    if (/\.(mjs|cjs|js)$/u.test(name)) return require(target);
    return loadTypescript(name.endsWith(".ts") || name.endsWith(".tsx") ? target : `${target}.ts`);
  }, module, module.exports);
  return module.exports;
}

// Evaluate a fresh, uncached copy of a module, e.g. to give each simulated
// browser tab its own module state. Its relative imports use the shared cache.
export function loadTypescriptIsolated(filename) {
  const resolved = path.resolve(projectRoot, filename);
  const module = { exports: {} };
  const require = createRequire(resolved);
  const code = compile(readFileSync(resolved, "utf8"));
  const execute = vm.runInThisContext(`(function(require, module, exports) {\n${code}\n})`, { filename: resolved });
  execute((name) => {
    if (name.endsWith("?url")) return name.slice(0, -4);
    if (!name.startsWith(".")) return require(name);
    const target = path.resolve(path.dirname(resolved), name);
    if (/\.(mjs|cjs|js)$/u.test(name)) return require(target);
    return loadTypescript(name.endsWith(".ts") || name.endsWith(".tsx") ? target : `${target}.ts`);
  }, module, module.exports);
  return module.exports;
}

export function loadAppCallback(name, bindings) {
  const filename = path.join(projectRoot, "src/App.tsx");
  const ast = ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "App");
  const declaration = app.body.statements
    .flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find((node) => node.name.getText(ast) === name);
  const initializer = declaration.initializer;
  const callback = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
  return vm.runInNewContext(compile(`(${callback.getText(ast)})`), bindings, { filename });
}
