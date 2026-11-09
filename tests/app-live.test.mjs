import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppCallback, loadTypescript } from './helpers/typescript.mjs';
import { canonicalJson } from '../shared/bike-operations.mjs';
import { sha256Hex } from '../shared/bike-knowledge.mjs';
import { assertWorkspaceBudget } from '../shared/bike-limits.mjs';
import { workspaceAttachmentAssets } from '../shared/bike-attachments.mjs';
import { createWorkspaceProposal } from '../shared/bike-proposals.mjs';

const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const fixture = (requests = 1) => {
  const workspace = migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{
    id: 'doc', title: 'Doc', nodes: [{ id: 'a', text: 'before', children: [] }],
  }] });
  const barrier = { current: workspace, scoped: workspace, workspaceId: 'replica', revision: 'base', writable: true };
  const started = deferred(), receipt = deferred(), proposals = [];
  let queries = 0;
  const bindings = {
    Error, canonicalJson, sha256Hex, assertWorkspaceBudget, workspaceAttachmentAssets, createWorkspaceProposal,
    liveGrantEpochRef: { current: 0 }, workspaceRef: { current: workspace },
    proposalRegistryRef: { current: new Map() }, liveRequestStatusesRef: { current: new Map() },
    liveReadBarrier: async () => barrier,
    queryOperationReceipt: async () => { if (++queries === requests) started.resolve(); return receipt.promise; },
    enqueueProposal: (proposal) => proposals.push(proposal),
  };
  const handler = loadAppCallback('handleLiveMcpRequest', bindings);
  const request = (text) => {
    const candidate = structuredClone(workspace);
    candidate.documents[0].nodes[0].text = text;
    return { method: 'proposal', session: { id: 'session', clientName: 'fixture' },
      grant: { scope: 'workspace', writable: true, documentIds: [] },
      payload: { requestId: 'same-request', workspaceId: 'replica', expectedRevision: 'base', candidate,
        operation: 'update_node', clientDigest: sha256Hex(text), dryRun: false } };
  };
  return { bindings, handler, request, started, receipt, proposals, barrier, queries: () => queries };
};

test('concurrent Live requests cannot register different candidates under one request identity', async () => {
  const f = fixture(2);
  const pending = [f.handler(f.request('first')), f.handler(f.request('different'))];
  await f.started.promise;
  f.receipt.resolve(null);
  const results = await Promise.allSettled(pending);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(results.find((result) => result.status === 'rejected')?.reason.message ?? '', /相同请求身份携带了不同内容/);
  assert.equal(f.proposals.length, 1);
  assert.equal(f.bindings.proposalRegistryRef.current.get('same-request').digest, f.proposals[0].candidateDigest);
});

for (const stage of ['barrier', 'receipt']) {
  test(`revoking a Live grant during the ${stage} await cannot enqueue its old request`, async () => {
    const f = fixture(), blocked = deferred();
    if (stage === 'barrier') f.bindings.liveReadBarrier = () => { f.started.resolve(); return blocked.promise; };
    const pending = f.handler(f.request('must not queue'));
    await f.started.promise;
    f.bindings.liveGrantEpochRef.current++;
    if (stage === 'barrier') blocked.resolve(f.barrier);
    f.receipt.resolve(null);
    await assert.rejects(pending, /授权已失效/);
    assert.equal(f.proposals.length, 0);
    assert.equal(f.bindings.proposalRegistryRef.current.size, 0);
    if (stage === 'barrier') assert.equal(f.queries(), 0);
  });
}

for (const status of ['rejected', 'invalidated']) {
  test(`Live ${status} identities retain their original candidate and cannot queue a different retry`, async () => {
    const f = fixture();
    const original = f.request('original');
    f.bindings.liveRequestStatusesRef.current.set('same-request', { status,
      candidateDigest: sha256Hex(canonicalJson(original.payload.candidate)), clientDigest: original.payload.clientDigest });
    f.receipt.resolve(null);
    assert.equal((await f.handler(original)).status, status);
    await assert.rejects(f.handler(f.request('different')), /相同请求身份携带了不同内容/);
    assert.equal(f.proposals.length, 0);
  });
}

test('Live caller digests must be bounded SHA-256 strings before receipt or proposal state is created', async () => {
  const f = fixture();
  f.receipt.resolve(null);
  for (const digest of ['x'.repeat(10_000), {}, 'invalid']) {
    const request = f.request('candidate');
    request.payload.clientDigest = digest;
    await assert.rejects(f.handler(request), /请求摘要格式无效/);
  }
  assert.equal(f.queries(), 0);
  assert.equal(f.proposals.length, 0);
});
