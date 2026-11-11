import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceStore, migrateWorkspace } from '../mcp/bike-core.mjs';
import { createBikeMcpServer } from '../mcp/bike-server.mjs';
import { createLiveWorkspaceStore } from '../mcp/bike-live.mjs';
import { canonicalJson } from '../shared/bike-operations.mjs';
import liveService from '../electron/live-mcp-service.cjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const build = process.env.BIKE_MYGO_BUILD ?? '1', channel = process.env.BIKE_MYGO_CHANNEL ?? 'preview';
const suffix = channel === 'preview' ? ' Preview' : '';
const binary = process.env.BIKE_MYGO_BINARY ?? path.join(root, 'release/mygo/2.0.0', `build-${build}-${channel}`, `Bike MyGO${suffix}.app/Contents/MacOS/bike-mygo`);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-mcp-'));
const fixture = JSON.parse(await fs.readFile(path.join(root, 'desktop-mygo/tests/fixtures/workspace.json')));
const report = { childPath: '/usr/bin:/bin', fileCases: [], liveCases: [] };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const wire = (value) => JSON.parse(JSON.stringify(value));
assert.notEqual(spawnSync('/usr/bin/env', ['node', '--version'], { env: { PATH: report.childPath } }).status, 0);
const identity = spawnSync(binary, ['--version'], { env: { PATH: report.childPath }, encoding: 'utf8' });
assert.equal(identity.status, 0, identity.stderr);
report.identity = JSON.parse(identity.stdout);
async function connect(args) {
  const transport = new StdioClientTransport({ command: binary, args, env: { PATH: report.childPath, DYLD_PRINT_LIBRARIES: '1' }, stderr: 'pipe' });
  let errors = ''; transport.stderr?.on('data', (data) => { errors += data; });
  const client = new Client({ name: 'bike-mygo-interop', version: '2.0.0' });
  try { await client.connect(transport); } catch (error) { await transport.close(); throw new Error(`${error.message} ${errors}`); }
  assert.doesNotMatch(errors, /WebKit[.]framework|Electron Framework|Chromium/i);
  return client;
}
async function reference(store) {
  const server = await createBikeMcpServer({ store, version: '2.0.0' });
  const client = new Client({ name: 'node-reference', version: '2.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }); if (result.isError) throw new Error(result.content[0].text);
  const value = JSON.parse(result.content[0].text); if (result.structuredContent) assert.deepEqual(wire(result.structuredContent), value); return value;
}
async function compare(client, node) {
  const sort = (result) => wire(result.tools).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(sort(await client.listTools()), sort(await node.listTools()));
  for (const [name, args] of [['get_workspace_summary', {}], ['list_documents', {}], ['search_outline', { query: '中文' }], ['get_document', { documentId: 'doc-m0' }], ['get_document', { documentId: 'doc-m0', format: 'markdown', metadata: true }], ['get_node', { documentId: 'doc-m0', nodeId: 'root' }], ['export_document', { documentId: 'doc-m0', format: 'json' }]]) {
    assert.deepEqual(await call(client, name, args), await call(node, name, args), name);
  }
  assert.deepEqual(await client.listResources(), await node.listResources());
  assert.deepEqual(await client.listResourceTemplates(), await node.listResourceTemplates());
  for (const [uri, name, value] of [['bike://document/{documentId}', 'documentId', 'MyGO'], ['bike://document-markdown/{documentId}', 'documentId', 'missing'], ['bike://node/{documentId}/{nodeId}', 'nodeId', 'root']]) {
    const params = { ref: { type: 'ref/resource', uri }, argument: { name, value } };
    assert.deepEqual(await client.complete(params), await node.complete(params));
  }
  for (const uri of ['bike://workspace/summary', 'bike://documents', 'bike://document/doc-m0', 'bike://document-markdown/doc-m0', 'bike://node/doc-m0/root']) assert.deepEqual(await client.readResource({ uri }), await node.readResource({ uri }), uri);
  const prompts = await node.listPrompts(); assert.deepEqual(await client.listPrompts(), wire(prompts));
  for (const item of prompts.prompts) assert.deepEqual(await client.getPrompt({ name: item.name, arguments: { documentId: 'doc-m0', nodeId: 'root' } }), await node.getPrompt({ name: item.name, arguments: { documentId: 'doc-m0', nodeId: 'root' } }), item.name);
  assert.deepEqual(await call(client, 'get_document', { documentId: 'doc-m0', unknownField: 'ignored' }), await call(node, 'get_document', { documentId: 'doc-m0', unknownField: 'ignored' }));
  await assert.rejects(client.callTool({ name: 'get_document', arguments: {} }), /-32602/);
}
try {
  for (const version of [1, 2, 3]) {
    const file = path.join(directory, `v${version}.json`), raw = JSON.stringify({ ...fixture, version }, null, 2) + String.fromCharCode(10);
    await fs.writeFile(file, raw);
    const client = await connect(['--mcp-file', '--workspace', file]);
    const node = await reference(new WorkspaceStore({ workspacePath: file, mode: 'readonly', debug: false, maxDocumentNodes: 2000, maxSearchResults: 50 }));
    try {
      await compare(client, node.client);
      const args = { documentId: 'doc-m0', title: 'Preview 中文🙂', expectedRevision: digest(raw), writeTimestamp: '2026-11-11T00:00:00.000Z' };
      assert.deepEqual(await call(client, 'update_document_title', args), await call(node.client, 'update_document_title', args));
      await assert.rejects(call(client, 'update_document_title', { ...args, dryRun: false }), /readonly/); assert.equal(await fs.readFile(file, 'utf8'), raw);
    } finally { await client.close(); await node.close(); }
    const writer = await connect(['--mcp-file', '--workspace', file, '--mode', 'write']);
    try {
      const args = { documentId: 'doc-m0', nodeId: 'root', text: `Written v${version}`, expectedRevision: digest(raw), writeTimestamp: '2026-11-11T00:00:00.000Z', dryRun: false };
      if (version === 3) { await assert.rejects(call(writer, 'update_node', args), /Live/); assert.equal(await fs.readFile(file, 'utf8'), raw); }
      else {
        const result = await call(writer, 'update_node', args); assert.equal(result.applied, true); assert.equal(result.nextWorkspaceRevision, digest(await fs.readFile(file))); assert.equal(await fs.readFile(path.join(directory, result.snapshot.path), 'utf8'), raw);
        await assert.rejects(call(writer, 'update_node', args), /revision/);
      }
      report.fileCases.push({ version, tools: 14, readsResourcesPrompts: true, controlledWrite: version < 3, v3WriteDenied: version === 3 });
    } finally { await writer.close(); }
  }
  const liveDirectory = path.join(directory, 'Bike-MyGO-preview'), discoveryPath = path.join(liveDirectory, 'live-mcp.json');
  const workspace = migrateWorkspace(fixture), states = new Map(), proposals = [];
  const service = liveService.createLiveMcpService({ directory: liveDirectory, handle(request) {
    if (request.method === 'snapshot') return { workspace, workspaceId: 'isolated-mygo', revision: 'live-revision', savedAt: '2026-11-11T00:00:00.000Z', writable: request.grant.writable };
    if (request.method === 'status') return states.get(request.payload.requestId) ?? { status: 'unknown' };
    const p = request.payload; proposals.push(p); const result = { status: p.dryRun ? 'preview' : 'pending', applied: false, clientDigest: p.clientDigest, candidateDigest: digest(canonicalJson(p.candidate)) };
    if (!p.dryRun) states.set(p.requestId, result); return result;
  } });
  await service.start({ documentIds: ['doc-m0'], writable: true });
  let client, node, store;
  try {
    store = await createLiveWorkspaceStore({ discoveryPath }); node = await reference(store); client = await connect(['--mcp-live', '--live-discovery', discoveryPath]); await compare(client, node.client);
    const args = { documentId: 'doc-m0', nodeId: 'root', text: 'Live candidate 中文🙂', expectedRevision: 'live-revision', requestId: 'fixed-preview', writeTimestamp: '2026-11-11T00:00:00.000Z' };
    const preview = await call(client, 'update_node', args); assert.deepEqual(preview, await call(node.client, 'update_node', args)); assert.deepEqual(proposals.at(-2), proposals.at(-1));
    const pending = await call(client, 'update_node', preview.confirmationArgs); states.clear(); assert.deepEqual(pending, await call(node.client, 'update_node', preview.confirmationArgs));
    const count = proposals.length; assert.equal((await call(client, 'update_node', preview.confirmationArgs)).status, 'pending'); assert.equal(proposals.length, count);
    await assert.rejects(call(client, 'update_node', { ...preview.confirmationArgs, text: 'changed' }), /相同请求身份/);
    states.set(preview.requestId, { ...states.get(preview.requestId), status: 'committed', operationId: 'approved-receipt' });
    assert.equal((await call(client, 'update_node', preview.confirmationArgs)).applied, true); assert.equal((await call(client, 'get_proposal_status', { requestId: preview.requestId })).operationId, 'approved-receipt');
    assert.equal(workspace.documents[0].nodes[0].text, fixture.documents[0].nodes[0].text);
    await assert.rejects(call(client, 'update_node', { ...args, dryRun: false, requestId: undefined }), /requestId/); await assert.rejects(call(client, 'update_node', { ...args, expectedRevision: 'stale' }), /revision/);
    await service.stop(); await assert.rejects(call(client, 'get_workspace_summary'), /Live/);
    report.liveCases.push({ tools: 15, readsResourcesPrompts: true, candidateDigestMatchesNode: true, confirmation: true, retryNoDuplicate: true, changedPayloadDenied: true, committedReceipt: true, revoked: true });
  } finally { await client?.close(); await node?.close(); store?.close(); await service.stop(); }
  const disconnected = spawnSync(binary, ['--mcp-live', '--live-discovery', discoveryPath], { env: { PATH: report.childPath }, encoding: 'utf8' }); assert.equal(disconnected.status, 1); assert.equal(disconnected.stdout, ''); assert.match(disconnected.stderr, /Live/);
  await fs.mkdir(path.join(root, 'output/mygo'), { recursive: true }); await fs.writeFile(path.join(root, 'output/mygo/mcp-interop.json'), JSON.stringify(report, null, 2) + String.fromCharCode(10));
  console.log('MyGO MCP interop passed. 14 File tools, 15 Live tools, resources, five prompts, controlled writes and approval retries.');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
