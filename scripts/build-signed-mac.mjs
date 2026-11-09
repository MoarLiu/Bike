import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(new URL("..", import.meta.url).pathname);
const { build, Platform } = require("electron-builder");
const identity = process.env.CSC_NAME;
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
if (process.platform !== "darwin" || !identity?.startsWith("Developer ID Application:") || !profile) {
  throw new Error("正式打包需要 macOS、CSC_NAME 的 Developer ID Application 身份，以及已保存的 APPLE_KEYCHAIN_PROFILE 公证凭据");
}
const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
if (!identities.includes(identity) && !process.env.CSC_LINK) throw new Error("签名身份在当前钥匙串中不可用");
process.env.BIKE_SIGNED_RELEASE = "1";
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "true";
const qualifier = identity.replace(/^Developer ID Application:\s*/u, "");
process.env.CSC_NAME = qualifier;
const files = await build({
  targets: Platform.MAC.createTarget(["dmg", "zip"], require("builder-util").Arch.arm64),
  publish: "never",
  config: {
    forceCodeSigning: true,
    dmg: { sign: true },
    mac: { identity: qualifier, hardenedRuntime: true, notarize: true, entitlements: "config/entitlements.mac.plist", entitlementsInherit: "config/entitlements.mac.plist" },
  },
});
const application = path.join(root, "release", "mac-arm64", "Bike.app");
execFileSync("codesign", ["--verify", "--deep", "--strict", application], { stdio: "inherit" });
execFileSync("xcrun", ["stapler", "validate", application], { stdio: "inherit" });
execFileSync("spctl", ["--assess", "--type", "execute", application], { stdio: "inherit" });
for (const filename of files.filter((name) => name.endsWith(".dmg"))) {
  const keychain = process.env.APPLE_KEYCHAIN ? ["--keychain", process.env.APPLE_KEYCHAIN] : [];
  execFileSync("xcrun", ["notarytool", "submit", filename, "--keychain-profile", profile, ...keychain, "--wait"], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", filename], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", filename], { stdio: "inherit" });
  const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");
  const update = await buildBlockMap(filename, "gzip", `${filename}.blockmap`);
  const version = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
  for (const name of (await fs.readdir(path.dirname(filename))).filter((name) => name.endsWith("-mac.yml"))) {
    const metadataPath = path.join(path.dirname(filename), name);
    const metadata = require("js-yaml").load(await fs.readFile(metadataPath, "utf8"));
    if (metadata.version !== version) continue;
    const entry = metadata.files.find((item) => item.url === path.basename(filename));
    if (!entry) throw new Error("更新清单缺少最终 DMG");
    Object.assign(entry, { sha512: update.sha512, size: update.size });
    if (metadata.path === entry.url) metadata.sha512 = update.sha512;
    metadata.releaseDate = new Date().toISOString();
    await fs.writeFile(metadataPath, require("js-yaml").dump(metadata));
  }
}
for (const filename of files.filter((name) => /\.(dmg|zip)$/u.test(name))) {
  const digest = createHash("sha256").update(await fs.readFile(filename)).digest("hex");
  await fs.writeFile(`${filename}.sha256`, `${digest}  ${path.basename(filename)}\n`);
}
