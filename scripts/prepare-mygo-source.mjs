import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const root = fileURLToPath(new URL('..', import.meta.url));
export const mygoSource = JSON.parse(await fs.readFile(path.join(root, 'desktop-mygo/mygo-source.json')));
const checksum = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export async function prepareMyGoSource(go = process.env.BIKE_MYGO_GO ?? 'go') {
  const cache = path.join(root, 'desktop-mygo/.cache');
  await fs.mkdir(cache, { recursive: true });
  assert.equal((await fs.lstat(cache)).isSymbolicLink(), false, 'MyGO source cache must be a real directory');
  const zipPath = path.join(cache, 'mygo-v0.8.3.zip');
  let available = false;
  try { available = checksum(await fs.readFile(zipPath)) === mygoSource.zipSHA256; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!available) {
    try {
      const moduleCache = execFileSync(go, ['env', 'GOMODCACHE'], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim();
      const original = await fs.readFile(path.join(moduleCache, 'cache/download/github.com/egoist/mygo/@v/v0.8.3.zip'));
      assert.equal(checksum(original), mygoSource.zipSHA256);
      await fs.writeFile(zipPath, original);
      available = true;
    } catch { /* The verified archive can be fetched independently of its Go directive. */ }
  }
  if (!available) {
    const proxies = process.env.BIKE_MYGO_MODULE_PROXY ? [process.env.BIKE_MYGO_MODULE_PROXY] : ['https://proxy.golang.org', 'https://goproxy.cn'];
    let failure;
    for (const proxy of proxies) {
      try {
        const base = new URL(proxy.endsWith('/') ? proxy : proxy + '/');
        assert.equal(base.protocol, 'https:');
        const response = await fetch(new URL('github.com/egoist/mygo/@v/v0.8.3.zip', base), { signal: AbortSignal.timeout(30000) });
        assert.ok(response.ok, `MyGO source download returned HTTP ${response.status}`);
        const archive = Buffer.from(await response.arrayBuffer());
        assert.ok(archive.length <= 64 * 1024 * 1024);
        assert.equal(checksum(archive), mygoSource.zipSHA256, 'Pinned MyGO archive checksum mismatch');
        await fs.writeFile(zipPath, archive);
        available = true;
        break;
      } catch (error) { failure = error; }
    }
    if (!available) throw failure;
  }
  const archive = await yauzl.openPromise(zipPath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
  const entries = new Map();
  let total = 0;
  const prefix = `${mygoSource.module}@${mygoSource.version}/`;
  try {
    assert.ok(archive.entryCount <= 10000);
    for await (const entry of archive.eachEntry()) {
      assert.ok(entry.fileName.startsWith(prefix) && !entry.fileName.split('/').includes('..'));
      assert.ok(!entry.fileName.endsWith('/') && entry.uncompressedSize <= 32 * 1024 * 1024);
      const stream = await archive.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) { total += chunk.length; assert.ok(total <= 256 * 1024 * 1024); chunks.push(chunk); }
      assert.equal(entries.has(entry.fileName), false);
      entries.set(entry.fileName, Buffer.concat(chunks));
    }
  } finally { archive.close(); }
  const hashes = [...entries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, bytes]) => checksum(bytes) + '  ' + name + String.fromCharCode(10)).join('');
  assert.equal('h1:' + crypto.createHash('sha256').update(hashes).digest('base64'), mygoSource.sum, 'MyGO module content checksum mismatch');
  const files = new Map([...entries].map(([name, bytes]) => [name.slice(prefix.length), bytes]));
  const originalMod = files.get('go.mod').toString();
  assert.equal(originalMod.split(mygoSource.upstreamGoDirective).length, 2);
  files.set('go.mod', Buffer.from(originalMod.replace(mygoSource.upstreamGoDirective, mygoSource.patchedGoDirective)));
  const destination = path.join(cache, 'mygo-v0.8.3-go126');
  let valid = false;
  try {
    assert.equal((await fs.lstat(destination)).isSymbolicLink(), false);
    const actual = (await fs.readdir(destination, { recursive: true })).filter((name) => files.has(name));
    assert.equal(actual.length, files.size);
    for (const [name, bytes] of files) assert.equal(checksum(await fs.readFile(path.join(destination, name))), checksum(bytes));
    for (const name of await fs.readdir(destination, { recursive: true })) {
      const info = await fs.lstat(path.join(destination, name));
      assert.equal(info.isSymbolicLink(), false);
      if (info.isFile()) assert.ok(files.has(name), `Unexpected file in pinned MyGO source ${name}`);
    }
    valid = true;
  } catch { /* Reconstruct a damaged cache from the verified archive. */ }
  if (!valid) {
    const staging = await fs.mkdtemp(path.join(cache, '.prepare-'));
    try {
      for (const [name, bytes] of files) { const file = path.join(staging, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(staging, destination);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  return { directory: destination, ...mygoSource };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = await prepareMyGoSource();
  console.log(`MyGO ${source.version} source verified. Applied ${source.patch} to its Go directive.`);
}
