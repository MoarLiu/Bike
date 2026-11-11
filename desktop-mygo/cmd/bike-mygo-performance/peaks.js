// Optional, one-operation acceptance cases. Both production renderers run this body.
const { sample, checkpoint, waitFor, frame, click, get, database } = helpers;
const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
const jsonHash = (value) => sha256(encoder.encode(JSON.stringify(value)));
const liveTool = async (operation, args = {}) => JSON.parse(await (globalThis.__performanceLiveTool
  ? globalThis.__performanceLiveTool(operation, JSON.stringify(args))
  : window.mygo.call('Performance.LiveTool', operation, JSON.stringify(args))));
const inspectAttachment = (assetId, digest) => globalThis.__performanceAttachmentEvidence
  ? globalThis.__performanceAttachmentEvidence(assetId, digest)
  : window.mygo.call('Performance.AttachmentEvidence', assetId, digest);
const output = { peakCase: config.scenario, peakAccepted: false, memory: [], stages: [], operationCount: 1, restartVerification: config.action === 'verify-peak' };
const capture = (name) => globalThis.__performanceCapture ? globalThis.__performanceCapture(name) : window.mygo.call('Performance.Capture', name);
const mark = async (label, started) => {
  output.stages.push({ label, elapsedMs: performance.now() - started });
  output.memory.push(await sample(label));
  await checkpoint(output);
};
const durableReceipt = (requestId) => new Promise((resolve, reject) => {
  const transaction = database.transaction('workspace-store', 'readonly');
  const request = transaction.objectStore('workspace-store').getAll();
  request.onsuccess = () => resolve(request.result.find((value) => value?.receipts?.[requestId])?.receipts[requestId] ?? null);
  request.onerror = () => reject(request.error);
});
const proposalChildren = () => Array.from({ length: 32 }, (_, index) => ({
  id: `peak-note-${index}`, text: `Peak note ${index}`,
  note: (`Deterministic peak note ${index}. `).repeat(1024).slice(0, 23 * 1024).padEnd(23 * 1024, '.'),
  checked: false, collapsed: false, color: 'plain', children: [],
}));
const verifyProposalContent = async () => {
  const saved = await get('workspace');
  const children = saved.documents.find((item) => item.id === 'perf-peak')?.nodes[0]?.children;
  const expected = proposalChildren();
  if (children?.length !== expected.length || children.some((node, index) => node.id !== expected[index].id || node.text !== expected[index].text || node.note !== expected[index].note)) throw new Error('Committed proposal content mismatch');
  return { children: children.length, noteBytes: expected.reduce((sum, node) => sum + encoder.encode(node.note).length, 0), contentSHA256: await jsonHash(children.map(({ id, text, note }) => ({ id, text, note }))), savedRevision: (await get('workspace-meta')).revision };
};
if (config.scenario === 'proposal-peak') {
  const started = performance.now();
  const requestId = 'performance-proposal-peak';
  const live = await window.bike.startLiveMcp({ scope: 'document', documentIds: ['perf-peak'], writable: true });
  if (!live.enabled) throw new Error('Production Live service did not start');
  try {
    if (config.action === 'verify-peak') {
      const status = await liveTool('status', { requestId });
      const receipt = await durableReceipt(requestId);
      if (status.status !== 'committed' || status.operationId !== config.expected.operationId || receipt?.operationId !== config.expected.operationId) throw new Error('Proposal receipt did not survive renderer/process restart');
      output.content = await verifyProposalContent();
      if (output.content.contentSHA256 !== config.expected.contentSHA256) throw new Error('Restarted proposal content hash mismatch');
      output.receipt = receipt;
      output.status = status;
      output.peakAccepted = true;
      await mark('proposal-restart-verified', started);
      return output;
    }
    await mark('proposal-idle', started);
    const snapshot = await liveTool('snapshot');
    const args = { requestId, documentId: 'perf-peak', parentNodeId: 'perf-peak-root', children: proposalChildren(), expectedRevision: snapshot.revision, dryRun: true,
      writeTimestamp: '2026-11-11T00:00:01.000Z', reason: 'MG11 single large proposal peak through production Live socket and renderer approval' };
    output.dimensions = { childNodes: args.children.length, maximumDepthAdded: 1, noteBytes: args.children.reduce((sum, node) => sum + encoder.encode(node.note).length, 0), commandJSONBytes: encoder.encode(JSON.stringify(args)).length, proposalBudgetBytes: 2 * MiB, socketRequestBudgetBytes: 4 * MiB };
    await mark('proposal-command-ready', started);
    const previewStart = performance.now();
    let preview = await liveTool('append_children', args);
    output.previewMs = performance.now() - previewStart;
    if (preview.status !== 'preview' || document.querySelector('.proposal-dialog')) throw new Error('Dry run did not remain a preview');
    const proposalJSONBytes = encoder.encode(JSON.stringify(preview.proposal)).length;
    if (proposalJSONBytes < 1.4 * MiB || proposalJSONBytes > 1.8 * MiB || preview.proposal.groups.length !== 1) throw new Error(`Large proposal dimensions outside focused budget (${proposalJSONBytes})`);
    output.dimensions.proposalJSONBytes = proposalJSONBytes;
    output.dimensions.proposalGroups = preview.proposal.groups.length;
    output.dimensions.proposalChanges = preview.proposal.groups[0].operation.changes.length;
    output.dimensions.budgetFraction = proposalJSONBytes / (2 * MiB);
    const confirmationArgs = preview.confirmationArgs;
    output.requestId = preview.requestId;
    if ((await get('workspace')).documents[0].nodes[0].children.length !== 0) throw new Error('Dry run changed durable content');
    await mark('proposal-preview-returned', started);
    preview = null;
    const pendingStart = performance.now();
    const pending = await liveTool('append_children', confirmationArgs);
    if (pending.status !== 'pending') throw new Error('Large proposal did not enter pending state');
    await waitFor(() => document.querySelector('.proposal-dialog') && document.querySelectorAll('.proposal-change').length === output.dimensions.proposalChanges, 'real pending proposal DOM');
    await frame();
    output.pendingUIReadyMs = performance.now() - pendingStart;
    output.pendingDOM = { dialogs: document.querySelectorAll('.proposal-dialog').length, groups: document.querySelectorAll('.proposal-group').length, changes: document.querySelectorAll('.proposal-change').length, selectedGroups: document.querySelectorAll('.proposal-group input:checked').length };
    if ((await liveTool('status', { requestId })).status !== 'pending') throw new Error('Pending receipt unavailable');
    await mark('proposal-pending-ui', started);
    await capture('proposal-pending');
    const acceptStart = performance.now();
    click('应用所选修改');
    await waitFor(async () => (await liveTool('status', { requestId })).status === 'committed', 'durable committed proposal receipt', 60000);
    output.acceptToCommittedMs = performance.now() - acceptStart;
    output.status = await liveTool('status', { requestId });
    output.receipt = await durableReceipt(requestId);
    if (!output.status.applied || !output.status.operationId || output.receipt?.operationId !== output.status.operationId) throw new Error('Committed receipt missing from IndexedDB');
    await mark('proposal-commit-confirmed', started);
    const validationStart = performance.now();
    output.content = await verifyProposalContent();
    const replay = await liveTool('append_children', confirmationArgs);
    if (replay.status !== 'committed' || replay.operationId !== output.status.operationId) throw new Error('Committed retry changed receipt');
    await waitFor(() => !document.querySelector('.proposal-dialog'), 'proposal dismissal');
    await frame();
    output.readbackValidationMs = performance.now() - validationStart;
    output.peakAccepted = true;
    await mark('proposal-readback-validated', started);
    output.endToEndMs = performance.now() - started;
    output.implementation = config.engine === 'mygo' ? 'Go LiveStore -> native LiveServer -> production renderer proposal -> normal Apply button -> IndexedDB receipt' : 'Node createLiveWorkspaceStore and appendChildrenForMcp -> formal Electron Live service -> production renderer proposal -> normal Apply button -> IndexedDB receipt';
    return output;
  } finally { await window.bike.stopLiveMcp(); }
}

const started = performance.now();
if (config.action === 'cleanup-peak') {
  const protectedScan = await window.bike.scanAttachments([config.expected.assetId]);
  if (!protectedScan.ok || protectedScan.candidates.some((item) => item.assetId === config.expected.assetId)) throw new Error('Protected original became a cleanup candidate');
  const scan = await window.bike.scanAttachments([]);
  if (!scan.ok || !scan.candidates.some((item) => item.assetId === config.expected.assetId && item.byteLength === 128 * MiB)) throw new Error('Unreferenced original absent from cleanup scan');
  const cleanup = await window.bike.cleanAttachments([], scan.ticket);
  if (!cleanup.ok) throw new Error(cleanup.error || 'Attachment quarantine cleanup failed');
  const after = await window.bike.scanAttachments([]);
  if (!after.ok || after.candidates.some((item) => item.assetId === config.expected.assetId)) throw new Error('Cleaned original remained in active library');
  output.cleanup = { protectedScan, unprotectedScan: scan, result: cleanup, afterScan: after, retention: 'normal production quarantine, temporary profile removed by runner' };
  output.peakAccepted = true;
  await mark('attachment-cleanup-verified', started);
  return output;
}
if (config.action === 'verify-peak') {
  output.original = await inspectAttachment(config.expected.assetId, config.expected.sha256);
  if (output.original.byteLength !== 128 * MiB || !output.original.originalBytesVerified || output.original.temporaryFiles.length) throw new Error('Restarted attachment verification failed');
  await mark('attachment-restart-original-verified', started);
  output.peakAccepted = true;
  return output;
}
await mark('attachment-idle', started);
let bytes = new Uint8Array(128 * MiB);
const pattern = new Uint8Array(65536);
for (let index = 0; index < pattern.length; index++) pattern[index] = (index * 31 + (index >>> 8)) & 255;
for (let offset = 0; offset < bytes.length; offset += pattern.length) bytes.set(pattern, offset);
output.dimensions = { files: 1, fileBytes: bytes.byteLength, singleFileBudgetBytes: 128 * MiB, batchFileBudget: 100, batchBytesBudget: 512 * MiB, source: 'renderer-owned ArrayBuffer with deterministic 65536-byte pattern', operationCount: 1 };
await mark('attachment-source-allocated', started);
const digest = await sha256(bytes);
output.sourceSHA256 = digest;
await mark('attachment-source-hashed', started);
if (config.engine === 'mygo') {
  output.runtimeObserver = { frozenRuntime: Object.isFrozen(window.mygo), callWritable: Object.getOwnPropertyDescriptor(window.mygo, 'call').writable };
  await window.mygo.call('Performance.AttachmentTransfer', true);
}
const transferStart = performance.now();
const imported = await window.bike.importAttachments({ requestId: 'performance-attachment-peak', files: [{ name: 'peak-original-128MiB.bin', bytes: bytes.buffer }] });
output.importMs = performance.now() - transferStart;
if (!imported.ok || imported.cancelled || imported.assets?.length !== 1 || imported.failures?.length) throw new Error(JSON.stringify(imported));
output.asset = imported.assets[0];
if (output.asset.assetId !== `sha256:${digest}` || output.asset.name !== 'peak-original-128MiB.bin' || output.asset.metadata.byteLength !== 128 * MiB || output.asset.metadata.mediaType !== 'application/octet-stream' || 'width' in output.asset.metadata || 'height' in output.asset.metadata) throw new Error('Returned attachment identity or metadata mismatch');
if (config.engine === 'mygo') {
  const trace = await window.mygo.call('Performance.AttachmentTransfer', false);
  const chunks = trace.chunks;
  output.memory.push(...trace.samples);
  output.transfer = { implementation: 'actual MyGO adapter ArrayBuffer -> base64 chunks -> Desktop.Invoke -> production Attachments upload and streamed Import', observer: trace.observer, errors: trace.errors, chunks, chunkBudgetBytes: MiB, chunkCount: chunks.length, decodedTotalBytes: chunks.reduce((sum, chunk) => sum + chunk.decodedBytes, 0), base64Characters: chunks.reduce((sum, chunk) => sum + chunk.base64Characters, 0), maximumChunkBytes: Math.max(...chunks.map((chunk) => chunk.decodedBytes)) };
  await checkpoint(output);
  if (trace.errors.length || chunks.length !== 128 || chunks.some((chunk, index) => !chunk.ok || chunk.offset !== index * MiB || chunk.decodedBytes !== MiB) || output.transfer.decodedTotalBytes !== 128 * MiB) throw new Error('Actual native transfer chunk dimensions differ from the 1 MiB bridge contract');
} else {
  output.transfer = { implementation: 'formal Electron preload ArrayBuffer -> one attachment-import IPC -> production putBytes', chunks: [], chunkCount: 1, decodedTotalBytes: bytes.byteLength, maximumChunkBytes: bytes.byteLength, chunkBudgetBytes: null };
}
await mark('attachment-import-returned', started);
const validationStart = performance.now();
output.original = await inspectAttachment(output.asset.assetId, digest);
if (!output.original.originalBytesVerified || output.original.byteLength !== 128 * MiB || output.original.temporaryFiles.length) throw new Error('Installed original validation or upload cleanup failed');
output.originalValidationMs = performance.now() - validationStart;
await mark('attachment-original-validated', started);
bytes = null;
output.peakAccepted = true;
output.endToEndMs = performance.now() - started;
await mark('attachment-source-released', started);
return output;
