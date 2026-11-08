import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { projectRoot } from "./helpers/typescript.mjs";

const installSource = readFileSync(path.join(projectRoot, "scripts/install.sh"), "utf8");

// Source of the functions from `first` up to (not including) `next`.
function installFunctions(first, next) {
  const start = installSource.indexOf(`\n${first}() {`);
  const end = installSource.indexOf(`\n${next}() {`);
  assert.ok(start >= 0 && end > start, `cannot slice ${first}..${next} from scripts/install.sh`);
  return installSource.slice(start, end);
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bike-installer-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Shared stubs. curl serves files from $FIXTURE_DIR by URL basename and logs every URL.
const stubs = `set -Eeuo pipefail
REPO=MoarLiu/Bike
GITHUB_BASE=https://github.com
RAW_BASE=https://raw.githubusercontent.com/MoarLiu/Bike/main
NODE_DIST_BASE=https://nodejs.org/dist
NODE_MAJOR=22
MIN_NODE_VERSION=22.13.0
err() { printf '%s\\n' "$*" >&2; }
warn() { printf 'WARN %s\\n' "$*" >&2; }
info() { :; }
success() { printf 'SUCCESS %s\\n' "$*" >&2; }
die() { printf 'DIE %s\\n' "$*" >&2; exit 1; }
run_or_sudo() { "$@"; }
need_command() { :; }
latest_tag() { die "latest_tag must not be called when BIKE_VERSION is pinned"; }
ensure_node() { :; }
ensure_sync_service_user() { :; }
curl() {
  local out= url=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o) out=$2; shift 2 ;;
      -*) shift ;;
      *) url=$1; shift ;;
    esac
  done
  printf 'CURL %s\\n' "$url" >&2
  [ -f "$FIXTURE_DIR/$(basename "$url")" ] || return 22
  cp "$FIXTURE_DIR/$(basename "$url")" "$out"
}
${installFunctions("sha256_check", "ensure_system_user")}
`;

function runInstaller(script, env) {
  return spawnSync("bash", ["-s"], { encoding: "utf8", env: { ...process.env, ...env }, input: `${stubs}\n${script}\n` });
}

const curledUrls = (result) => [...result.stderr.matchAll(/^CURL (.*)$/gm)].map((match) => match[1]);

// Builds Bike-Web-<version>-sync-server.tar.gz plus its SHA256SUMS file in a fixture dir.
function releaseFixture(root, { version = "1.4.3", files, checksum }) {
  const source = path.join(root, `package-${version}`);
  const fixtures = path.join(root, "fixtures");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), content);
  }
  mkdirSync(fixtures, { recursive: true });
  const asset = `Bike-Web-${version}-sync-server.tar.gz`;
  const archive = path.join(fixtures, asset);
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, ...new Set(Object.keys(files).map((name) => name.split("/")[0]))], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assert.equal(packed.status, 0, packed.stderr);
  writeFileSync(path.join(fixtures, `SHA256SUMS-${version}.txt`), `${checksum ?? sha256(archive)}  ${asset}\n`);
  return fixtures;
}

const releaseFiles = {
  "scripts/install.sh": "#!/usr/bin/env bash\necho 'manager script from the v1.4.3 release'\n",
  "scripts/setup-sync-server.sh": "#!/usr/bin/env bash\necho 'setup script from the v1.4.3 release'\n",
  "server/auth-server.mjs": "export {};\n",
};

function installEnv(root, fixtures, version = "v1.4.3") {
  const installDir = path.join(root, "opt/bike");
  const tmpDir = path.join(root, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  return { INSTALL_DIR: installDir, MANAGER_PATH: path.join(installDir, "bike.sh"), TMP_DIR: tmpDir, VERSION: version, FIXTURE_DIR: fixtures };
}

const releaseFunctions = () => installFunctions("resolve_release_tag", "run_setup");

test("Release download refuses a package whose SHA-256 does not match", (t) => {
  const root = tempDir(t);
  const script = `${releaseFunctions()}
archive_path="$(download_release_package v1.4.3)"
printf 'EXTRACT %s\\n' "$archive_path"`;

  const good = runInstaller(script, installEnv(root, releaseFixture(root, { files: releaseFiles })));
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^EXTRACT .*Bike-Web-1\.4\.3-sync-server\.tar\.gz$/m);

  const tampered = runInstaller(script, installEnv(root, releaseFixture(root, { files: releaseFiles, checksum: "0".repeat(64) })));
  assert.notEqual(tampered.status, 0);
  assert.doesNotMatch(tampered.stdout, /EXTRACT/);
  assert.match(tampered.stderr, /DIE .*SHA-256/);
});

test("Installing files takes the manager and setup scripts only from the verified package", (t) => {
  const root = tempDir(t);
  const env = installEnv(root, releaseFixture(root, { files: releaseFiles }));
  mkdirSync(env.INSTALL_DIR, { recursive: true });
  writeFileSync(env.MANAGER_PATH, "old manager\n");

  const result = runInstaller(`${releaseFunctions()}\ninstall_or_update_files 0`, env);
  assert.equal(result.status, 0, result.stderr);
  const urls = curledUrls(result);
  assert.ok(urls.length > 0);
  for (const url of urls) assert.match(url, /^https:\/\/github\.com\/MoarLiu\/Bike\/releases\/download\/v1\.4\.3\//);
  assert.equal(readFileSync(env.MANAGER_PATH, "utf8"), releaseFiles["scripts/install.sh"]);
  assert.ok(statSync(env.MANAGER_PATH).mode & 0o100, "manager script is executable");
  assert.equal(existsSync(`${env.MANAGER_PATH}.new`), false);
  assert.equal(
    readFileSync(path.join(env.INSTALL_DIR, "scripts/setup-sync-server.sh"), "utf8"),
    releaseFiles["scripts/setup-sync-server.sh"],
  );
});

test("Packages without a manager script keep the installed one instead of downloading main", (t) => {
  const root = tempDir(t);
  const { "scripts/install.sh": _manager, ...olderRelease } = releaseFiles;
  const env = installEnv(root, releaseFixture(root, { version: "1.4.2", files: olderRelease }), "v1.4.2");
  mkdirSync(env.INSTALL_DIR, { recursive: true });
  writeFileSync(env.MANAGER_PATH, "installed manager\n");

  const result = runInstaller(`${releaseFunctions()}\ninstall_or_update_files 0`, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARN .*scripts\/install\.sh/);
  for (const url of curledUrls(result)) assert.match(url, /\/releases\/download\/v1\.4\.2\//);
  assert.equal(readFileSync(env.MANAGER_PATH, "utf8"), "installed manager\n");
});

test("update-script installs the manager script from the verified release for BIKE_VERSION", (t) => {
  const root = tempDir(t);
  const env = installEnv(root, releaseFixture(root, { files: releaseFiles }));
  mkdirSync(env.INSTALL_DIR, { recursive: true });
  writeFileSync(env.MANAGER_PATH, "old manager\n");

  const updated = runInstaller(`${releaseFunctions()}\nupdate_manager_script`, env);
  assert.equal(updated.status, 0, updated.stderr);
  for (const url of curledUrls(updated)) assert.match(url, /^https:\/\/github\.com\/MoarLiu\/Bike\/releases\/download\/v1\.4\.3\//);
  assert.equal(readFileSync(env.MANAGER_PATH, "utf8"), releaseFiles["scripts/install.sh"]);
  assert.match(updated.stderr, /SUCCESS .*v1\.4\.3/);

  writeFileSync(env.MANAGER_PATH, "old manager\n");
  const tamperedEnv = installEnv(root, releaseFixture(root, { files: releaseFiles, checksum: "f".repeat(64) }));
  const tampered = runInstaller(`${releaseFunctions()}\nupdate_manager_script`, tamperedEnv);
  assert.notEqual(tampered.status, 0);
  assert.equal(readFileSync(env.MANAGER_PATH, "utf8"), "old manager\n");
});

test("Bundled Node.js is extracted only after its SHASUMS256 entry matches", (t) => {
  const root = tempDir(t);
  const fixtures = path.join(root, "fixtures");
  mkdirSync(fixtures, { recursive: true });
  const archiveName = "node-v22.99.0-linux-x64.tar.xz";
  writeFileSync(path.join(fixtures, archiveName), "fake node archive\n");
  const goodHash = sha256(path.join(fixtures, archiveName));
  const script = `${installFunctions("install_node_runtime", "ensure_node")}
detect_node_platform() { printf linux; }
detect_node_arch() { printf x64; }
latest_node_version() { die "BIKE_NODE_VERSION is pinned"; }
node_version_ok() { return 0; }
tar() {
  printf 'TAR %s\\n' "$*" >&2
  mkdir -p "$INSTALL_DIR/.node/node-v22.99.0-linux-x64/bin"
  printf '#!/bin/sh\\necho v22.99.0\\n' > "$INSTALL_DIR/.node/node-v22.99.0-linux-x64/bin/node"
  chmod +x "$INSTALL_DIR/.node/node-v22.99.0-linux-x64/bin/node"
}
install_node_runtime
printf 'NODE_BIN=%s\\n' "$NODE_BIN"`;

  const run = (shasums) => {
    const shasumsPath = path.join(fixtures, "SHASUMS256.txt");
    if (shasums === null) rmSync(shasumsPath, { force: true });
    else writeFileSync(shasumsPath, shasums);
    const work = mkdtempSync(path.join(root, "run-"));
    return runInstaller(script, { ...installEnv(work, fixtures), BIKE_NODE_VERSION: "v22.99.0" });
  };

  const verified = run(`${"1".repeat(64)}  node-v22.99.0-darwin-arm64.tar.xz\n${goodHash}  ${archiveName}\n`);
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(curledUrls(verified), [
    `https://nodejs.org/dist/v22.99.0/${archiveName}`,
    "https://nodejs.org/dist/v22.99.0/SHASUMS256.txt",
  ]);
  assert.match(verified.stderr, /^TAR --no-same-owner -xJf \S+\/node-v22\.99\.0-linux-x64\.tar\.xz -C \S+\/\.node$/m);
  assert.match(verified.stdout, /^NODE_BIN=.*\/\.node\/node-v22\.99\.0-linux-x64\/bin\/node$/m);

  const failures = {
    "wrong hash": `${"0".repeat(64)}  ${archiveName}\n`,
    "only substring matches": `${goodHash}  ${archiveName}.asc\n${goodHash}  win/${archiveName}\n`,
    "malformed hash": `abc  ${archiveName}\n`,
    "missing SHASUMS256.txt": null,
  };
  for (const [label, shasums] of Object.entries(failures)) {
    const result = run(shasums);
    assert.notEqual(result.status, 0, `${label}: must fail`);
    assert.doesNotMatch(result.stderr, /^TAR /m, `${label}: must not extract`);
    assert.match(result.stderr, /^DIE /m, `${label}: must explain`);
  }
});

test("Web service installation never takes ownership of Sync data", () => {
  const source = readFileSync(path.join(projectRoot, "scripts/install.sh"), "utf8");
  const install = source.slice(source.indexOf("install_web_service() {"), source.indexOf("\nstart_web_service() {"));
  const commands = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, FIXTURE_CONFIG: path.join(projectRoot, "config/bike.config.example.json") },
    input: `set -euo pipefail
INSTALL_DIR=/fixture/bike
WEB_SERVICE_USER=bike-web
WEB_SERVICE_NAME=bike-web
NODE_BIN=/fixture/node
ensure_node() { :; }
systemd_available() { return 0; }
tty_available() { return 1; }
web_config_path() { printf '%s' "$FIXTURE_CONFIG"; }
id() { if [[ "$1" == -gn ]]; then printf 'bike-web'; fi; }
sudo_cmd() { printf '%s\\n' "$*"; }
mktemp() { printf /dev/null; }
success() { :; }
die() { exit 1; }
${install}
install_web_service
`,
  });
  assert.equal(commands.status, 0, commands.stderr);
  assert.match(commands.stdout, /systemctl enable bike-web\.service/);
  assert.match(commands.stdout, /chown bike-web:bike-web .*bike\.config\.example\.json/);
  assert.doesNotMatch(commands.stdout, /chown[^\n]*\/fixture\/bike\/data/);
});

test("Web service unit gives the Web server a systemd state directory", (t) => {
  const unit = path.join(tempDir(t), "bike-web.service");
  const result = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, FIXTURE_CONFIG: path.join(projectRoot, "config/bike.config.example.json"), UNIT_OUT: unit },
    input: `set -euo pipefail
INSTALL_DIR=/fixture/bike
WEB_SERVICE_USER=bike-web
WEB_SERVICE_NAME=bike-web
NODE_BIN=/fixture/node
ensure_node() { :; }
systemd_available() { return 0; }
tty_available() { return 1; }
web_config_path() { printf '%s' "$FIXTURE_CONFIG"; }
id() { if [[ "$1" == -gn ]]; then printf 'bike-web'; fi; }
sudo_cmd() { :; }
mktemp() { printf '%s' "$UNIT_OUT"; }
success() { :; }
die() { exit 1; }
${installFunctions("install_web_service", "start_web_service")}
install_web_service
`,
  });
  assert.equal(result.status, 0, result.stderr);
  const service = readFileSync(unit, "utf8").split("[Install]")[0].split("[Service]")[1];
  assert.match(service, /^StateDirectory=bike-web$/m);
  assert.match(service, /^ReadWritePaths=\/fixture\/bike\/data$/m);
  assert.match(service, /^ProtectSystem=full$/m);
});

function webUpgradeFixture(t, { stateDirectory = "", failReload = false } = {}) {
  const root = tempDir(t);
  const systemDir = path.join(root, "systemd");
  const tmpDir = path.join(root, "tmp");
  const unit = path.join(systemDir, "custom-bike.service");
  const dropin = path.join(systemDir, "custom-bike.service.d", "50-bike-session-state.conf");
  mkdirSync(systemDir);
  mkdirSync(tmpDir);
  const original = `[Unit]\nDescription=Custom Bike\n[Service]\nUser=custom-user\nGroup=custom-group\nExecStart=/custom/node /custom/bike/server/auth-server.mjs\nEnvironment=BIKE_CONFIG=/custom/config.json\n${stateDirectory ? `StateDirectory=${stateDirectory}\n` : ""}`;
  writeFileSync(unit, original);
  const result = spawnSync("bash", ["-s"], {
    encoding: "utf8",
    env: { ...process.env, FIXTURE_SYSTEM_DIR: systemDir, TMP_DIR: tmpDir, FIXTURE_STATE_DIRECTORY: stateDirectory, FAIL_RELOAD: String(failReload) },
    input: `set -Eeuo pipefail
WEB_SERVICE_NAME=custom-bike
systemd_available() { return 0; }
web_service_installed() { return 0; }
install_or_update_files() { printf 'files-updated\\n'; }
restart_web_service() { printf 'service-restarted\\n'; }
success() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
sudo_cmd() {
  if [[ "$1" == systemctl ]]; then
    case "$2" in
      show)
        if [[ -n "$FIXTURE_STATE_DIRECTORY" ]]; then
          printf '%s' "$FIXTURE_STATE_DIRECTORY"
        elif [[ -f "$FIXTURE_SYSTEM_DIR/custom-bike.service.d/50-bike-session-state.conf" ]]; then
          printf custom-bike
        fi
        ;;
      daemon-reload)
        printf 'unit-reloaded\\n'
        [[ "$FAIL_RELOAD" != true ]]
        ;;
      *) exit 90 ;;
    esac
    return
  fi
  local args=() arg
  for arg in "$@"; do
    case "$arg" in
      /etc/systemd/system/*) arg="$FIXTURE_SYSTEM_DIR/\${arg#/etc/systemd/system/}" ;;
    esac
    args+=("$arg")
  done
  "\${args[@]}"
}
${installFunctions("migrate_web_service_state", "start_web_service")}
${installFunctions("update_web_action", "install_sync_action")}
update_web_action
update_web_action
`,
  });
  return { result, unit, dropin, original };
}

test("update-web adds persistent session storage before restarting an old unit and preserves custom settings", (t) => {
  const { result, unit, dropin, original } = webUpgradeFixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(unit, "utf8"), original);
  assert.equal(readFileSync(dropin, "utf8"), "[Service]\nStateDirectory=custom-bike\n");
  assert.equal(statSync(dropin).mode & 0o777, 0o644);
  assert.equal(existsSync(`${dropin}.new`), false);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "files-updated", "unit-reloaded", "service-restarted",
    "files-updated", "service-restarted",
  ]);
});

test("update-web keeps a custom state directory and never replaces the service unit", (t) => {
  const { result, unit, dropin, original } = webUpgradeFixture(t, { stateDirectory: "custom-state other-state" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(unit, "utf8"), original);
  assert.equal(existsSync(dropin), false);
  assert.doesNotMatch(result.stdout, /unit-reloaded/);
});

test("update-web does not restart when the state directory migration fails", (t) => {
  const { result, unit, original } = webUpgradeFixture(t, { failReload: true });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(unit, "utf8"), original);
  assert.doesNotMatch(result.stdout, /service-restarted/);
});

test("Legacy sync installer shim never runs an install.sh from the current directory", (t) => {
  const root = tempDir(t);
  const shim = readFileSync(path.join(projectRoot, "scripts/install-sync-server.sh"), "utf8");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  // Stands in for the documented curl bootstrap; nothing touches the network.
  writeFileSync(path.join(bin, "curl"), "#!/bin/sh\necho 'echo BOOTSTRAP \"$@\"'\n");
  chmodSync(path.join(bin, "curl"), 0o755);
  writeFileSync(path.join(root, "install.sh"), "echo DECOY\n");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BIKE_RAW_BASE: "https://example.invalid/raw" };

  const piped = spawnSync("bash", ["-s", "--", "install"], { encoding: "utf8", cwd: root, env, input: shim });
  assert.equal(piped.status, 0, piped.stderr);
  assert.doesNotMatch(piped.stdout, /DECOY/);
  assert.match(piped.stdout, /^BOOTSTRAP install-sync$/m);

  const scripts = path.join(root, "package/scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(scripts, "install-sync-server.sh"), shim);
  writeFileSync(path.join(scripts, "install.sh"), 'echo SIBLING "$@"\n');
  const fromFile = spawnSync("bash", [path.join(scripts, "install-sync-server.sh"), "update"], { encoding: "utf8", cwd: root, env });
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.match(fromFile.stdout, /^SIBLING update-sync$/m);
});
