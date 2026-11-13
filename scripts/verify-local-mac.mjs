import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const asar = builderRequire("@electron/asar");
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");
const version = JSON.parse(await fs.readFile(path.join(root, "package.json"))).version;
const directory = path.join(root, "release");
const app = path.join(directory, "mac-arm64/Bike.app");
const archive = path.join(app, "Contents/Resources/app.asar");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 120000 }).trim();
const hash = (data, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(data).digest(encoding);
const plist = (bundle, key) => run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path.join(bundle, "Contents/Info.plist")]);
const verifyApp = bundle => {
  assert.equal(plist(bundle, "CFBundleIdentifier"), "com.bike.app");
  assert.equal(plist(bundle, "CFBundleShortVersionString"), version);
  assert.equal(plist(bundle, "CFBundleVersion"), version);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
};
verifyApp(app);
const entries = asar.listPackage(archive).map(file => file.replace(/^\//, ""));
let sourceFiles = 0;
for (const file of entries) {
  if (!/^(electron|shared|mcp|dist)\//.test(file) || asar.statFile(archive, file).files) continue;
  const current = await fs.readFile(path.join(root, file));
  assert.equal(hash(asar.extractFile(archive, file)), hash(current), `Packaged source differs: ${file}`);
  sourceFiles++;
}
for (const name of ["react", "react-dom", "lucide-react", "mygo-runtime", "pdf-lib", "@pdf-lib/fontkit"])
  assert.ok(!entries.some(file => file === `node_modules/${name}/package.json`), `Renderer-only dependency shipped: ${name}`);
const fonts = JSON.parse(await fs.readFile(path.join(root, "public/licenses/fonts/sources.json")));
for (const font of fonts) {
  const extension = path.extname(font.file), stem = path.basename(font.file, extension);
  const asset = entries.find(file => file.startsWith(`dist/assets/${stem}-`) && file.endsWith(extension));
  assert.ok(asset, `Font missing: ${font.file}`);
  assert.equal(hash(asar.extractFile(archive, asset)), font.sha256);
  assert.ok(asar.extractFile(archive, `dist/licenses/fonts/${font.license}`).length > 100);
}
const manifest = require("js-yaml").load(await fs.readFile(path.join(directory, "latest-mac.yml"), "utf8"));
assert.equal(manifest.version, version);
const artifacts = [];
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bike-candidate-check-"));
try {
  for (const extension of ["dmg", "zip"]) {
    const name = `Bike-${version}-arm64.${extension}`, file = path.join(directory, name);
    const bytes = await fs.readFile(file), entry = manifest.files.find(item => item.url === name);
    assert.equal(entry?.size, bytes.length);
    assert.equal(entry?.sha512, hash(bytes, "sha512", "base64"));
    if (extension === "zip") {
      assert.equal(manifest.path, name);
      assert.equal(manifest.sha512, entry.sha512);
    }
    const rebuilt = path.join(temporary, `${extension}.blockmap`);
    await buildBlockMap(file, "gzip", rebuilt);
    assert.ok(gunzipSync(await fs.readFile(`${file}.blockmap`), { maxOutputLength: 64 * 1024 * 1024 })
      .equals(gunzipSync(await fs.readFile(rebuilt))), `Blockmap mismatch: ${name}`);
    const sha256 = hash(bytes);
    await fs.writeFile(`${file}.sha256`, `${sha256}  ${name}\n`);
    assert.equal((await fs.readFile(`${file}.sha256`, "utf8")).split(/\s/)[0], sha256);
    artifacts.push({ file: name, bytes: bytes.length, sha256 });
  }
  const mount = path.join(temporary, "mounted");
  await fs.mkdir(mount);
  let mounted = false;
  try {
    run("/usr/bin/hdiutil", ["verify", "-quiet", path.join(directory, `Bike-${version}-arm64.dmg`)]);
    run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, path.join(directory, `Bike-${version}-arm64.dmg`)]);
    mounted = true;
    const bundled = path.join(mount, "Bike.app");
    verifyApp(bundled);
    assert.equal(hash(await fs.readFile(path.join(bundled, "Contents/Resources/app.asar"))), hash(await fs.readFile(archive)));
  } finally { if (mounted) run("/usr/bin/hdiutil", ["detach", mount]); }
  const extracted = path.join(temporary, "zip");
  run("/usr/bin/ditto", ["-x", "-k", path.join(directory, `Bike-${version}-arm64.zip`), extracted]);
  verifyApp(path.join(extracted, "Bike.app"));
  assert.equal(hash(await fs.readFile(path.join(extracted, "Bike.app/Contents/Resources/app.asar"))), hash(await fs.readFile(archive)));
  const result = { version, sourceFiles, fonts: fonts.map(font => font.file), artifacts,
    verification: "Local candidate integrity only; no Developer ID or notarization claim", published: false };
  const output = path.join(root, `output/review-${version}`);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "electron-package.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
