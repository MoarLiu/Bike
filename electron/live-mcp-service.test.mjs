import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { createLiveWorkspaceStore } from '../mcp/bike-live.mjs';
import { updateNodeForMcp } from '../mcp/bike-core.mjs';
const { createLiveMcpService } = createRequire(import.meta.url)('./live-mcp-service.cjs');
const fixture = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-live-test-'));
  const workspace = { version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', nodes: [{ id: 'node', text: 'latest', children: [] }] }] };
  const calls = [];
  const service = createLiveMcpService({ directory, handle: async (request) => {
    calls.push(request);
    if (request.method === 'snapshot') return { workspace, workspaceId: 'local-workspace', revision: 'current-revision', savedAt: new Date().toISOString(), writable: request.grant.writable };
    if (request.method === 'status') return { status: 'pending' };
    return { status: request.payload.dryRun ? 'preview' : 'pending', applied: false };
  } });
  t.after(async () => { await service.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { service, directory, calls };
};

test('Live is disabled by default, discovery and socket stay private, stdio adapter reads live data', async (t) => {
  const { service, directory, calls } = await fixture(t);
  assert.equal(service.state().enabled, false);
  await service.start({ documentIds: ['doc'] });
  const file = path.join(directory, 'live-mcp.json'), discovery = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(discovery.socketPath))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(discovery.socketPath)).mode & 0o777, 0o600);
  const store = await createLiveWorkspaceStore({ discoveryPath: file, clientName: 'self-reported' }); t.after(store.close);
  const snapshot = await store.load();
  assert.equal(snapshot.workspace.documents[0].nodes[0].text, 'latest');
  assert.equal(calls[0].session.clientName, 'self-reported');
  assert.match(calls[0].session.id, /^[a-f0-9-]{36}$/);
  assert.equal(snapshot.config.mode, 'readonly');
  const preview = await updateNodeForMcp(store, { documentId: 'doc', nodeId: 'node', text: 'candidate', expectedRevision: snapshot.revision });
  assert.equal(preview.status, 'preview');
  await assert.rejects(updateNodeForMcp(store, preview.confirmationArgs), /只读/);
  assert.equal(calls.filter((call) => call.method === 'proposal').length, 1);
});

test('authorized writes queue confirmation and revocation disconnects all sessions', async (t) => {
  const { service, directory, calls } = await fixture(t);
  await service.start({ documentIds: ['doc'], writable: true });
  const store = await createLiveWorkspaceStore({ discoveryPath: path.join(directory, 'live-mcp.json') }); t.after(store.close);
  const preview = await updateNodeForMcp(store, { documentId: 'doc', nodeId: 'node', text: 'candidate', expectedRevision: 'current-revision' });
  const pending = await updateNodeForMcp(store, preview.confirmationArgs);
  assert.equal(pending.applied, false); assert.equal(pending.status, 'pending');
  assert.equal(calls.at(-1).grant.writable, true);
  await service.stop();
  await assert.rejects(store.load(), /断开/);
  await assert.rejects(fs.stat(path.join(directory, 'live-mcp.json')), (e) => e.code === 'ENOENT');
});

test('bad connection tokens are refused before reaching the renderer', async (t) => {
  const { service, directory, calls } = await fixture(t);
  await service.start({ documentIds: ['doc'] });
  const discovery = JSON.parse(await fs.readFile(path.join(directory, 'live-mcp.json'), 'utf8'));
  const socket = net.createConnection(discovery.socketPath);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  socket.write(JSON.stringify({ id: 'bad', method: 'snapshot', token: '0'.repeat(64) }) + '\n');
  await closed;
  assert.equal(calls.length, 0);
});

test('null packets and Unicode tokens cannot crash the Live listener', async (t) => {
  const { service, directory } = await fixture(t);
  await service.start({ documentIds: ['doc'] });
  const discovery = JSON.parse(await fs.readFile(path.join(directory, 'live-mcp.json'), 'utf8'));
  for (const packet of [null, { id: 'unicode', method: 'snapshot', token: '😀'.repeat(32) }]) {
    const socket = net.createConnection(discovery.socketPath);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(JSON.stringify(packet) + '\n'); await closed;
  }
  const valid = await createLiveWorkspaceStore({ discoveryPath: path.join(directory, 'live-mcp.json') }); t.after(valid.close);
  assert.equal((await valid.load()).workspace.documents[0].id, 'doc');
});
