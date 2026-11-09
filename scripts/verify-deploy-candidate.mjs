import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { createSecretHash, createSessionSecret } from '../server/password.mjs';
const archive = path.resolve(process.argv[2]);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-deploy-candidate-'));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${output.slice(-2000)}`))); child.on('error', reject);
});
const port = async () => { const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const number = server.address().port; await new Promise((resolve) => server.close(resolve)); return number; };
let child;
try {
  await run('tar', ['-xzf', archive]);
  await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
  const mcp = await run(process.execPath, ['mcp/bike-server.mjs', '--help']);
  if (!mcp.startsWith('Bike MCP')) throw new Error('deployment package MCP entry is unavailable');
  await fs.copyFile(new URL('../mcp/bike-server.smoke.mjs', import.meta.url), path.join(directory, 'mcp/bike-server.smoke.mjs'));
  await run(process.execPath, ['mcp/bike-server.smoke.mjs']);
  const p = await port();
  const fixturePassword = createSessionSecret();
  const config = path.join(directory, 'config/candidate.json');
  await fs.writeFile(config, JSON.stringify({ host: '127.0.0.1', port: p, auth: { username: 'fixture', passwordHash: createSecretHash(fixturePassword), sessionSecret: createSessionSecret(), secureCookies: true }, sync: { enabled: true, databasePath: 'data/candidate.sqlite', deviceTokenHashes: [createSecretHash('fixture-device')] } }), { mode: 0o600 });
  let logs = '';
  const start = async () => {
    child = spawn(process.execPath, ['server/auth-server.mjs'], { cwd: directory, env: { ...process.env, BIKE_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (chunk) => { logs += chunk; }); child.stdout.on('data', (chunk) => { logs += chunk; });
    for (let i = 0; i < 100; i++) { try { const response = await fetch(`http://127.0.0.1:${p}/login`); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 50)); }
    throw new Error('deployment failed to start: ' + logs.slice(-2000));
  };
  const stop = async () => { const closed = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await closed; child = null; };
  await start();
  const login = await fetch(`http://127.0.0.1:${p}/auth/login`, { method: 'POST', body: new URLSearchParams({ username: 'fixture', password: fixturePassword }), redirect: 'manual' });
  if (login.status !== 302 || !login.headers.get('set-cookie')?.includes('Secure')) throw new Error('secure cookie login failed');
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const home = await fetch(`http://127.0.0.1:${p}/`, { headers: { Cookie: cookie } });
  if (!home.ok || !(await home.text()).includes('id="root"')) throw new Error('built web app unavailable');
  const put = await fetch(`http://127.0.0.1:${p}/api/documents/candidate`, { method: 'PUT', headers: { Authorization: 'Bearer fixture-device', 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: null, document: { id: 'candidate', title: 'Candidate', nodes: [] } }) });
  if (!put.ok) throw new Error('candidate upload failed: ' + await put.text());
  const manifest = await fetch(`http://127.0.0.1:${p}/api/sync/manifest`, { headers: { Authorization: 'Bearer fixture-device' } });
  if (!(await manifest.json()).capabilities?.includes('attachments-v1')) throw new Error('attachment capability is unavailable');
  const assetId = `sha256:${'a'.repeat(64)}`;
  const attached = {
    id: 'candidate-attached', title: 'Attached',
    nodes: [{ id: 'attached-node', text: 'File', children: [], attachmentRefs: [{ assetId, name: 'fixture.txt' }] }],
    attachments: { version: 1, items: { [assetId]: { mediaType: 'application/octet-stream', byteLength: 1 } } },
  };
  const attachmentUrl = `http://127.0.0.1:${p}/api/documents/${attached.id}`;
  const attachmentHeaders = { Authorization: 'Bearer fixture-device', 'Content-Type': 'application/json' };
  const attachmentPut = await fetch(attachmentUrl, { method: 'PUT', headers: attachmentHeaders, body: JSON.stringify({ expectedRevision: null, document: attached, capabilities: ['attachments-v1'] }) });
  if (!attachmentPut.ok) throw new Error('attachment metadata upload failed');
  const legacyPut = await fetch(attachmentUrl, { method: 'PUT', headers: attachmentHeaders, body: JSON.stringify({ expectedRevision: 1, document: { id: attached.id, title: 'Old client', nodes: [] } }) });
  if (legacyPut.status !== 426) throw new Error('old-client overwrite was not rejected');
  await stop();
  // Re-extract the deployment archive over an existing installation. Preserve
  // real data/config, then prove revision CAS still sees the previous database.
  await run('tar', ['-xzf', archive]);
  await start();
  const read = await fetch(`http://127.0.0.1:${p}/api/documents/candidate`, { headers: { Authorization: 'Bearer fixture-device' } });
  const body = await read.json();
  if (body.revision !== 1 || body.document.title !== 'Candidate') throw new Error('upgrade lost existing data');
  const attachmentRead = await fetch(attachmentUrl, { headers: { Authorization: 'Bearer fixture-device' } });
  const attachmentBody = await attachmentRead.json();
  if (attachmentBody.revision !== 1 || attachmentBody.document.nodes[0].attachmentRefs[0].assetId !== assetId) throw new Error('upgrade or old-client write lost attachment metadata');
  const currentManifest = await (await fetch(`http://127.0.0.1:${p}/api/sync/manifest`, { headers: attachmentHeaders })).json();
  if (!currentManifest.capabilities?.includes('node-operations-v2')) throw new Error('node operation capability is unavailable');
  const enabled = await fetch(`http://127.0.0.1:${p}/api/v2/enable`, { method: 'POST', headers: attachmentHeaders,
    body: JSON.stringify({ expectedRevision: currentManifest.workspaceRevision }) });
  if (!enabled.ok || (await enabled.json()).protocol !== 2) throw new Error('node operation protocol upgrade failed');
  const protectedPut = await fetch(attachmentUrl, { method: 'PUT', headers: attachmentHeaders, body: JSON.stringify({ expectedRevision: 1, document: attached, capabilities: ['attachments-v1'] }) });
  if (protectedPut.status !== 426) throw new Error('old protocol wrote into an upgraded space');
  const checkpoint = await fetch(`http://127.0.0.1:${p}/api/v2/checkpoint`, { headers: attachmentHeaders });
  if (!checkpoint.ok || (await checkpoint.json()).documents.length !== 2) throw new Error('upgraded checkpoint is unavailable');
  const assetBytes = Buffer.from('deployment-original-attachment');
  const hash = createHash('sha256').update(assetBytes).digest('hex');
  const assetUrl = `http://127.0.0.1:${p}/api/v2/assets/${hash}`;
  const leaseResponse = await fetch(`${assetUrl}/lease`, { method: 'POST', headers: attachmentHeaders,
    body: JSON.stringify({ byteLength: assetBytes.length, mediaType: 'application/octet-stream' }) });
  if (!leaseResponse.ok) throw new Error('deployment attachment lease failed');
  const lease = await leaseResponse.json();
  const chunk = await fetch(`${assetUrl}/chunks?uploadId=${lease.uploadId}&offset=0`, { method: 'PUT',
    headers: { Authorization: 'Bearer fixture-device' }, body: assetBytes });
  if (!chunk.ok) throw new Error('deployment attachment upload failed');
  const installed = await fetch(`${assetUrl}/finish`, { method: 'POST', headers: attachmentHeaders, body: JSON.stringify({ uploadId: lease.uploadId }) });
  if (!installed.ok) throw new Error('deployment attachment installation failed');
  const downloaded = await fetch(assetUrl, { headers: attachmentHeaders });
  if (!downloaded.ok || !Buffer.from(await downloaded.arrayBuffer()).equals(assetBytes)) throw new Error('deployment attachment bytes changed');
  await stop();
  const modes = {};
  for (const file of ['config/candidate.json', 'data/candidate.sqlite']) modes[file] = (await fs.stat(path.join(directory, file))).mode & 0o777;
  if (Object.values(modes).some((mode) => mode !== 0o600)) throw new Error('private file modes changed');
  console.log(JSON.stringify({ runtime: process.version, platform: process.platform, checks: ['clean archive extraction', 'production dependency install', 'MCP entry, shared file-lock dependency and stdio smoke', 'real login Secure cookie', 'built Web page', 'Sync upload', 'attachment capability and HTTP 426 for old-client overwrite', 'archive upgrade and restart preserves revision, content and attachment metadata', 'v2 capability, explicit upgrade, checkpoint and old-protocol protection', 'original attachment lease, upload, verified installation and download', 'private config/database permissions'], modes }, null, 2));
} finally { if (child) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } await fs.rm(directory, { recursive: true, force: true }); }
