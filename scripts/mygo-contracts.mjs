import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBikeMcpServer } from '../mcp/bike-server.mjs';
import { buildWorkspaceIndex, documentToMarkdown, exportDocumentForMcp, getDocument, getNode, listDocuments, migrateWorkspace, searchOutline } from '../mcp/bike-core.mjs';
import { WorkspaceStore, appendChildrenForMcp, createDocumentForMcp, createNodeForMcp, deleteNodeForMcp, moveNodeForMcp, setNodeCheckedForMcp, updateDocumentTitleForMcp, updateNodeForMcp } from '../mcp/bike-core.mjs';
import { scanLinks, summarizeKnowledge, anchorMarkdownReferences } from '../shared/bike-knowledge.mjs';
import { parseMarkdownDocument } from '../shared/bike-markdown.mjs';
import * as limits from '../shared/bike-limits.mjs';
import * as attachments from '../shared/bike-attachments.mjs';
import { canonicalJson, OPERATION_LIMITS, OPERATION_PROTOCOL } from '../shared/bike-operations.mjs';
import { createHash } from 'node:crypto';
import * as network from '../shared/bike-network.mjs';
import { BIKE_TEMPLATES } from '../shared/bike-templates.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const productVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const write = process.argv.includes('--write');
const output = async (relative, value) => {
  const file = path.join(root, relative);
  const text = JSON.stringify(value, null, 2) + '\n';
  if (write) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  } else {
    assert.equal(await fs.readFile(file, 'utf8'), text, `${relative} drifted. Review and regenerate with npm run mygo:contracts:generate.`);
  }
};

await output('desktop-mygo/internal/contracts/limits.json', {
  documentBytes: limits.MAX_DOCUMENT_BYTES, documentNodes: limits.MAX_DOCUMENT_NODES, desktopDepth: limits.MAX_DESKTOP_DEPTH,
  jsonDepth: limits.MAX_JSON_DEPTH, attachmentBytes: attachments.MAX_ATTACHMENT_BYTES,
  imageBytes: attachments.MAX_IMAGE_BYTES, imagePixels: attachments.MAX_IMAGE_PIXELS,
  importFiles: attachments.MAX_IMPORT_FILES, importBytes: attachments.MAX_IMPORT_BYTES,
  operationProtocol: OPERATION_PROTOCOL, operationBytes: OPERATION_LIMITS.bytes, operationLimits: OPERATION_LIMITS,
  aiTimeoutMs: network.AI_TIMEOUT_MS, syncTimeoutMs: network.SYNC_TIMEOUT_MS,
  aiResponseBytes: network.MAX_AI_RESPONSE_BYTES, syncResponseBytes: network.MAX_SYNC_RESPONSE_BYTES,
});
const jsonVectors = [
  '{"z":1,"中文🙂":"value","a":{"b":2,"a":1}}',
  '{"negativeZero":-0,"small":1e-7,"large":1e21,"infinite":1e999,"fraction":0.125}',
  '{"2":"two","10":"ten","1":"one","01":"leading","4294967295":"string"}',
  JSON.stringify({ html: '<tag>&', separators: String.fromCharCode(0x2028, 0x2029), controls: '\n\r\t\b\f', surrogate: String.fromCharCode(0xd800), low: String.fromCharCode(0xdc00), emoji: '🙂', quote: '"' }),
  JSON.stringify(Object.fromEntries([['￿', 1], ['🙂', 2], [String.fromCharCode(0xd800), 3], ['a', [null, true, false, 1.2345678901234567]]])),
  '{"__proto__":{"polluted":true},"duplicate":1,"duplicate":2}',
];
await output('desktop-mygo/tests/fixtures/canonical-json.json', jsonVectors.map((raw) => {
  const value = JSON.parse(raw);
  const canonical = canonicalJson(value);
  return { raw, canonical, pretty: JSON.stringify(value, null, 2), digest: createHash('sha256').update(canonical).digest('hex') };
}));
const normalizedCases = [1, 2, 3].map((version) => {
  const raw = { extension: { unicode: '中文🙂', number: 0.125 }, version, activeDocumentId: 'missing', documents: [{
    id: 'doc', title: '  fixture 中文🙂  ', createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T01:00:00.000Z',
    isShortcut: null, nodes: [{ id: 'root', custom: 'kept', text: 'root', children: [{ id: 'child', note: 42 }],
      color: 'invalid', table: [['cell', 42], 'discard'], codeBlock: 'a\r\nb', codeLanguage: '🙂'.repeat(41) }],
  }] };
  return { raw: JSON.stringify(raw), normalized: JSON.stringify(migrateWorkspace(raw), null, 2) };
});
await output('desktop-mygo/tests/fixtures/workspace-normalization.json', normalizedCases);
const readWorkspace = migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{
  id: 'doc', title: 'Fixture **bold** #tag', createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T01:00:00.000Z',
  nodes: [{ id: 'root', text: 'Link [[Other]] and `[[ignored]]`', note: 'link [[Other#Target|custom]]\nsecond line', headingLevel: 1,
    children: [{ id: 'child', text: '#tag **text**', checked: true, table: [['A|B', '[[Other]]'], ['cell', '']], codeBlock: '```\n[[Other]]', codeLanguage: 'go ~ignored', children: [] }] }],
}, { id: 'other', title: 'Other', createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', nodes: [{ id: 'target', text: 'Target', children: [] }] }] });
const explicitWorkspace = structuredClone(readWorkspace);
explicitWorkspace.documents[0].knowledge = { version: 1, references: [{ id: 'reference', source: { kind: 'node-field', nodeId: 'root', field: 'note', start: 5, end: 5 + '[[Other#Target|custom]]'.length, raw: '[[Other#Target|custom]]' }, target: { documentId: 'other', nodeId: 'target' }, labelMode: 'custom' }], relations: [{ id: 'relation', fromNodeId: 'root', toNodeId: 'child', label: 'contains' }] };
const markdownWorkspace = structuredClone(readWorkspace);
markdownWorkspace.documents[0] = migrateWorkspace({ version: 3, documents: [{ id: 'doc', title: 'Source', createdAt: '2026-11-10T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z', markdownSource: '# Source\n\n- link [[Other]]', nodes: [{ id: 'source-node', text: 'link [[Other]]', children: [] }] }] }).documents[0];
const readCases = [readWorkspace, explicitWorkspace, markdownWorkspace].map((workspace) => ({
  raw: JSON.stringify(workspace),
  documents: workspace.documents.map((document) => ({ id: document.id, markdown: documentToMarkdown(document), metadataMarkdown: documentToMarkdown(document, { metadata: true }), knowledge: summarizeKnowledge(workspace, document) })),
  calls: (() => {
    const snapshot = { workspace, index: buildWorkspaceIndex(workspace), config: { maxDocumentNodes: 2000, maxSearchResults: 50 } };
    return [
      ['list_documents', {}, listDocuments],
      ['list_documents', { query: 'fixture', limit: 1, includeStats: false }, listDocuments],
      ['search_outline', { query: 'Other' }, searchOutline],
      ['search_outline', { query: 'Other', limit: 1 }, searchOutline],
      ['get_document', { documentId: 'doc' }, getDocument],
      ['get_document', { documentId: 'doc', maxDepth: 0 }, getDocument],
      ['get_document', { documentId: 'doc', format: 'json' }, getDocument],
      ['get_document', { documentId: 'doc', format: 'markdown', metadata: true }, getDocument],
      ['get_node', { documentId: 'doc', nodeId: workspace.documents[0].nodes[0].id, includeSiblings: true }, getNode],
      ['export_document', { documentId: 'doc', format: 'json' }, exportDocumentForMcp],
      ['export_document', { documentId: 'doc', format: 'markdown' }, exportDocumentForMcp],
    ].map(([name, args, run]) => ({ name, args, expected: run(snapshot, args) }));
  })(),
}));
await output('desktop-mygo/tests/fixtures/mcp-read-vectors.json', readCases);
const anchorCases = [
  '# Title\n\n- duplicate [[Other]]\n- duplicate [[Other]]',
  '# Title [[Other]]\n\n- Same [[Other]]',
  '# Title\n\n- Root\n  [file](bike-attachment:sha256:' + 'a'.repeat(64) + ')\n  > attached note [[Other]]',
  '# Title\n\n- Root\n  > first [[Other]]\n  > next [[Other#Target]]\n- Root\n  > first [[Other]]',
  '# Title\n\n## Heading [[Other]]\n\nparagraph [[Other]]\ncontinued [[Other#Target|x]]\n\n- Nested\n  continuation [[Other]]',
  '\ufeff# Title\r\n\r\n- escaped \\*word\\* [[Other]]\r\n  > 🙂 [[Other]]',
  '# Title\n\n```js\n[[Other]]\n```\n\n- Real [[Other]]\n\n| A | B |\n| --- | --- |\n| [[Other]] | x |',
].map((source, caseIndex) => {
  const attachments = { version: 1, items: { ['sha256:' + 'a'.repeat(64)]: { mediaType: 'application/octet-stream', byteLength: 1 } } };
  const document = parseMarkdownDocument(source, { documentId: 'doc', now: '2026-11-13T00:00:00.000Z', previousDocument: { id: 'doc', title: 'Title', nodes: [], attachments } });
  document.attachments = attachments;
  let index = 0;
  const identify = nodes => nodes.forEach(node => { node.id = `source-${caseIndex}-${index++}`; identify(node.children); });
  identify(document.nodes);
  document.knowledge = { version: 1, references: scanLinks(document.markdownSource).map((link,index) => ({ id:`ref-${index}`,source:{kind:'markdown',start:link.start,end:link.end,raw:link.raw},target:{documentId:'other'},labelMode:'auto' })), relations:[] };
  const workspace = { version: 3, activeDocumentId: 'doc', documents: [document, { id: 'other', title: 'Other', nodes: [{ id: 'target', text: 'Target', children: [] }] }] };
  return {document, workspace, expected:anchorMarkdownReferences(document), connections:summarizeKnowledge(workspace, document)};
});
await output('desktop-mygo/tests/fixtures/markdown-anchors.json', anchorCases);

const writeCases = [];
const writeFunctions = {
  create_document: createDocumentForMcp, update_document_title: updateDocumentTitleForMcp,
  create_node: createNodeForMcp, append_children: appendChildrenForMcp,
  update_node: updateNodeForMcp, set_node_checked: setNodeCheckedForMcp,
  move_node: moveNodeForMcp, delete_node: deleteNodeForMcp,
};
const writeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-mygo-write-vectors-'));
const recordWrite = async (label, workspace, name, input, { error = false, mode = 'readonly' } = {}) => {
  const raw = JSON.stringify(workspace, null, 2) + '\n';
  const file = path.join(writeDirectory, 'workspace.json');
  await fs.writeFile(file, raw);
  const revision = createHash('sha256').update(raw).digest('hex');
  const args = { expectedRevision: revision, dryRun: true, reason: 'fixture', writeTimestamp: '2026-11-11T00:00:00.000Z', ...input };
  const store = new WorkspaceStore({ workspacePath: file, mode, debug: false, maxDocumentNodes: 2000, maxSearchResults: 50 });
  let nextRaw;
  const mutate = store.mutate.bind(store);
  store.mutate = ({ apply, ...options }) => mutate({
    ...options,
    apply(draft, context) {
      const preview = apply(draft, context);
      nextRaw = JSON.stringify(migrateWorkspace(structuredClone(draft)), null, 2) + '\n';
      return preview;
    },
  });
  let expected;
  try { expected = await writeFunctions[name](store, args); }
  catch (failure) {
    if (!error) throw failure;
    writeCases.push({ label, raw, name, mode, args, expectedError: failure.message });
    assert.equal(await fs.readFile(file, 'utf8'), raw, `${label} changed the workspace on failure`);
    return;
  }
  assert.equal(error, false, `${label} should have failed`);
  assert.equal(createHash('sha256').update(nextRaw).digest('hex'), expected.nextWorkspaceRevision);
  assert.equal(await fs.readFile(file, 'utf8'), raw, `${label} changed the workspace during preview`);
  writeCases.push({ label, raw, name, mode, args, expected, nextRaw, nextDigest: createHash('sha256').update(canonicalJson(JSON.parse(nextRaw))).digest('hex') });
};
try {
  const basicWrites = [
    ['create_document', { documentId: 'created-doc', title: 'Created', initialNodes: [{ id: 'new-root', text: 'new', children: [{ id: 'new-child', text: 'child' }] }] }],
    ['update_document_title', { documentId: 'other', title: 'Renamed#Other' }],
    ['create_node', { documentId: 'doc', parentNodeId: 'root', id: 'created-node', text: 'new', position: 'first', checked: true }],
    ['append_children', { documentId: 'doc', parentNodeId: 'root', children: [{ id: 'append-1', text: 'A' }, { id: 'append-2', text: 'B' }] }],
    ['update_node', { documentId: 'doc', nodeId: 'root', text: 'Renamed root 中文🙂', note: 'new [[Other]]', checked: true, codeLanguage: '  rust  ' }],
    ['set_node_checked', { documentId: 'doc', nodeId: 'child', checked: false }],
    ['move_node', { documentId: 'doc', nodeId: 'child', position: 'first' }],
    ['delete_node', { documentId: 'doc', nodeId: 'child' }],
  ];
  for (const version of [1, 2, 3]) {
    for (const [name, input] of basicWrites) {
      await recordWrite(`v${version}-${name}`, { ...readWorkspace, version }, name, input);
    }
  }
  for (const [name, input] of basicWrites) await recordWrite(`explicit-${name}`, explicitWorkspace, name, input);
  const attachedWorkspace = structuredClone(explicitWorkspace);
  attachedWorkspace.version = 2;
  const assetId = `sha256:${'a'.repeat(64)}`;
  attachedWorkspace.documents[0].attachments = { version: 1, items: { [assetId]: { mediaType: 'application/octet-stream', byteLength: 1 } } };
  attachedWorkspace.documents[0].nodes[0].attachmentRefs = [{ assetId, name: 'fixture.bin' }];
  for (const [name, input] of basicWrites) await recordWrite(`v2-attachments-${name}`, attachedWorkspace, name, input);

  const rich = structuredClone(readWorkspace);
  rich.extension = { unicode: '中文🙂', small: 1e-7, large: 1e21, negativeZero: -0 };
  rich.documents[0].extension = { preserved: true };
  rich.documents[0].nodes[0].extension = { preserved: true };
  rich.documents[0].nodes[0].collapsed = true;
  rich.documents[0].nodes[0].children.push({ id: 'sibling', text: 'sibling', children: [] });
  const extraWrites = [
    ['create_document', { documentId: 'created-doc', title: '﻿ title ﻿', initialNodes: [{ id: 'new-root', text: '', note: 42, color: 'invalid', checked: true, isTodo: false, codeBlock: 'a\r\nb\rc', codeLanguage: '🙂'.repeat(41) }] }],
    ['create_node', { documentId: 'doc', id: 'created-node', text: '', note: '中文🙂', position: 'anything', children: [{ id: 'created-child', text: 'child', children: [{ id: 'created-grandchild', text: 'grandchild' }] }] }],
    ['append_children', { documentId: 'doc', parentNodeId: 'root', position: 'first', children: [{ id: 'append-1', text: 'one', codeBlock: '', codeLanguage: ' ' }, { id: 'append-2', text: 'two', checked: true }] }],
    ['update_document_title', { documentId: 'other', title: 'Other' }],
    ['update_node', { documentId: 'doc', nodeId: 'child', color: 'invalid', checked: false, isTodo: false, collapsed: true, codeBlock: null, codeLanguage: '' }],
    ['update_node', { documentId: 'doc', nodeId: 'root', text: 'Link [[Other]] and `[[ignored]]`', note: '', codeBlock: 'a\r\nb\rc', codeLanguage: '🙂'.repeat(41) }],
    ['update_node', { documentId: 'doc', nodeId: 'root', text: null }],
    ['move_node', { documentId: 'doc', nodeId: 'sibling', targetParentNodeId: 'child', position: 'first' }],
    ['move_node', { documentId: 'doc', nodeId: 'sibling', targetParentNodeId: 'root', position: 'first' }],
    ['move_node', { documentId: 'doc', nodeId: 'root', position: 'last' }],
    ['delete_node', { documentId: 'doc', nodeId: 'sibling' }],
    ['create_node', { documentId: 'doc', id: '\ufeff created-node \ufeff', text: 'trimmed id' }],
    ['create_document', { documentId: '\ufeff created-doc \ufeff', title: 'trimmed id', initialNodes: [{ id: 'created-root', text: 'root' }] }],
    ['update_node', { documentId: 'doc', nodeId: 'root', checked: true, isTodo: false }],
  ];
  for (const [index, [name, input]] of extraWrites.entries()) await recordWrite(`edge-${index}-${name}`, rich, name, input);

  const references = structuredClone(readWorkspace);
  const source = references.documents[0];
  source.nodes[0].text = '🙂 [[Other]] [[Other#Target]] [[Other#Target|kept]]';
  source.nodes[0].note = '🙂 [[Other#Target]] [[Other#Target]] [[Other]]';
  source.markdownSource = '# Fixture **bold** #tag\n\n- ' + source.nodes[0].text + '\n  > ' + source.nodes[0].note;
  const noteLinks = scanLinks(source.nodes[0].note);
  source.knowledge = { version: 1, references: noteLinks.map((link, index) => ({
    id: `reference-${index}`, source: { kind: 'node-field', nodeId: 'root', field: 'note', start: link.start, end: link.end, raw: link.raw },
    target: { documentId: 'other', ...(link.nodeName ? { nodeId: 'target' } : {}) }, labelMode: index === 1 ? 'custom' : 'auto',
  })), relations: [{ id: 'relation', fromNodeId: 'root', toNodeId: 'child', label: 'contains', extension: true }] };
  const staleReferences = structuredClone(references);
  staleReferences.documents[0].knowledge.references[0].source.start = -1;
  staleReferences.documents[0].knowledge.references[0].source.end = -1;
  const lockedReferences = structuredClone(references);
  lockedReferences.documents[0].knowledge.version = 99;
  const ambiguousReferences = structuredClone(references);
  ambiguousReferences.documents.push({ ...structuredClone(references.documents[1]), id: 'other-duplicate', nodes: [{ id: 'duplicate-target', text: 'Target', children: [] }] });
  const groupedReferences = structuredClone(references);
  groupedReferences.documents[0].knowledge.sourceGroups = { grouped: { raw: '[[Other#Target]]', candidates: [{ nodeId: 'root', field: 'note', start: noteLinks[0].start, end: noteLinks[0].end }] } };
  groupedReferences.documents[0].knowledge.references[0].source = { kind: 'markdown', groupId: 'grouped', start: -1, end: -1, raw: '[[Other#Target]]' };
  for (const [kind, workspace] of [['references', references], ['stale', staleReferences], ['locked', lockedReferences], ['ambiguous', ambiguousReferences], ['grouped', groupedReferences]]) {
    await recordWrite(`${kind}-document-rename`, workspace, 'update_document_title', { documentId: 'other', title: '新#文档|🙂]' });
    await recordWrite(`${kind}-node-rename`, workspace, 'update_node', { documentId: 'other', nodeId: 'target', text: '新#主题|🙂]' });
  }
  for (const [index, note] of ['prefix 🙂 [[Other#Target]] [[Other#Target]] [[Other]]', '🙂 [[Other#Target]] [[Other]]', 'removed', '🙂 [[Other]] [[Other#Target]] [[Other#Target]]'].entries()) {
    await recordWrite(`relocate-note-${index}`, references, 'update_node', { documentId: 'doc', nodeId: 'root', note });
  }
  const subtree = structuredClone(rich);
  subtree.documents[0].nodes[0].children[0].children.push({ id: 'grandchild', text: 'grandchild', children: [] });
  subtree.documents[0].nodes.push({ id: 'second-root', text: 'Second root', children: [] });
  await recordWrite('delete-subtree', subtree, 'delete_node', { documentId: 'doc', nodeId: 'child' });
  await recordWrite('delete-first-root', subtree, 'delete_node', { documentId: 'doc', nodeId: 'root' });
  await recordWrite('move-before-target-index-shift', subtree, 'move_node', { documentId: 'doc', nodeId: 'root', targetParentNodeId: 'second-root' });
  const markdownReference = structuredClone(markdownWorkspace);
  const markdownDocument = markdownReference.documents[0];
  const rawLink = '[[Other]]';
  const start = markdownDocument.markdownSource.indexOf(rawLink);
  markdownDocument.knowledge = { version: 1, references: [{ id: 'markdown-reference', source: { kind: 'markdown', start, end: start + rawLink.length, raw: rawLink }, target: { documentId: 'other' }, labelMode: 'auto' }], relations: [] };
  await recordWrite('markdown-anchor-rename', markdownReference, 'update_document_title', { documentId: 'other', title: 'New Other' });
  await recordWrite('markdown-anchor-edit', markdownReference, 'update_node', { documentId: 'doc', nodeId: 'source-node', note: 'updated' });
  const deletedBinding = structuredClone(markdownReference);
  deletedBinding.documents[0].knowledge.references[0].target.documentId = 'deleted';
  await recordWrite('markdown-deleted-binding', deletedBinding, 'update_document_title', { documentId: 'other', title: 'New Other' });
  const failures = [
    ['missing-revision', 'update_document_title', { documentId: 'doc', title: 'new', expectedRevision: '' }],
    ['stale-revision', 'update_document_title', { documentId: 'doc', title: 'new', expectedRevision: 'stale' }],
    ['timestamp-date', 'update_document_title', { documentId: 'doc', title: 'new', writeTimestamp: '2026-02-30T00:00:00Z' }],
    ['timestamp-offset', 'update_document_title', { documentId: 'doc', title: 'new', writeTimestamp: '2026-11-11T08:00:00+08:00' }],
    ['missing-document', 'create_node', { documentId: 'missing', id: 'created-node' }],
    ['blank-title', 'update_document_title', { documentId: 'doc', title: '﻿ \t' }],
    ['missing-parent', 'create_node', { documentId: 'doc', parentNodeId: 'missing', id: 'created-node' }],
    ['append-missing-parent', 'append_children', { documentId: 'doc', parentNodeId: 'missing', children: [{ id: 'created-node' }] }],
    ['empty-children', 'append_children', { documentId: 'doc', parentNodeId: 'missing', children: [] }],
    ['missing-node', 'update_node', { documentId: 'doc', nodeId: 'missing', text: 'new' }],
    ['unchanged-update', 'update_node', { documentId: 'doc', nodeId: 'root' }],
    ['self-move', 'move_node', { documentId: 'doc', nodeId: 'root', targetParentNodeId: 'root' }],
    ['descendant-move', 'move_node', { documentId: 'doc', nodeId: 'root', targetParentNodeId: 'child' }],
    ['missing-move-target', 'move_node', { documentId: 'doc', nodeId: 'child', targetParentNodeId: 'missing' }],
    ['readonly-write', 'set_node_checked', { documentId: 'doc', nodeId: 'root', checked: true, dryRun: false }],
  ];
  for (const [label, name, args] of failures) await recordWrite(label, readWorkspace, name, args, { error: true });
  await recordWrite('v3-write', readWorkspace, 'set_node_checked', { documentId: 'doc', nodeId: 'root', checked: true, dryRun: false }, { error: true, mode: 'write' });
  await recordWrite('timestamp-no-fraction', readWorkspace, 'set_node_checked', { documentId: 'doc', nodeId: 'root', checked: true, writeTimestamp: '2026-11-11T00:00:00Z' });
  await recordWrite('timestamp-short-fraction', readWorkspace, 'set_node_checked', { documentId: 'doc', nodeId: 'root', checked: true, writeTimestamp: '2026-11-11T00:00:00.1Z' });
  const chain = (depth) => { let node = { id: `deep-${depth}`, text: 'deep' }; for (let i = depth - 1; i >= 0; i--) node = { id: `deep-${i}`, text: 'deep', children: [node] }; return node; };
  await recordWrite('write-depth-boundary', readWorkspace, 'create_node', { documentId: 'doc', ...chain(64) });
  await recordWrite('write-depth-overflow', readWorkspace, 'create_node', { documentId: 'doc', ...chain(65) }, { error: true });
  await recordWrite('write-node-count-overflow', readWorkspace, 'append_children', { documentId: 'doc', children: Array.from({ length: 2000 }, (_, i) => ({ id: `wide-${i}` })) }, { error: true });
} finally { await fs.rm(writeDirectory, { recursive: true, force: true }); }
await output('desktop-mygo/tests/fixtures/mcp-write-vectors.json', writeCases);
await output('desktop-mygo/tests/fixtures/wiki-vectors.json', ['[[Other]]', '\\[[Other]] and [[Other#Target|custom]]', '`[[ignored]]` [[Other]]', '```\n[[ignored]]\n```\n[[Other]]', '[[Other\\#label|custom]]', '🙂 [[Other]]'].map((text) => ({ text, links: scanLinks(text) })));

let bridge;
vm.runInNewContext(await fs.readFile(path.join(root, 'electron/preload.cjs'), 'utf8'), {
  require(name) {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, value) { if (name === 'bike') bridge = value; } }, ipcRenderer: {} };
  },
});
assert.equal(Object.keys(bridge).length, 36);
const declarations = ts.createSourceFile('vite-env.d.ts', await fs.readFile(path.join(root, 'src/vite-env.d.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const bridgeInterface = declarations.statements.find((statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === 'BikeDesktopBridge');
assert.ok(bridgeInterface, 'BikeDesktopBridge interface missing');
assert.deepEqual(bridgeInterface.members.map((member) => member.name.getText()).sort(), Object.keys(bridge).sort(), 'Electron preload and TypeScript bridge members differ');
const adapter = ts.createSourceFile('mygo.ts', await fs.readFile(path.join(root, 'src/platform/mygo.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
let adapterBridge;
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText() === 'bridge' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) adapterBridge = node.initializer;
  ts.forEachChild(node, visit);
};
visit(adapter);
assert.ok(adapterBridge, 'MyGO bridge adapter missing');
assert.deepEqual(adapterBridge.properties.map((member) => member.name.getText()).sort(), Object.keys(bridge).sort(), 'MyGO adapter must cover all existing bridge members');
await output('desktop-mygo/tests/fixtures/desktop-bridge.json', {
  baseline: 'electron/preload.cjs',
  members: Object.keys(bridge).sort().map((name) => ({ name, kind: name.startsWith('on') ? 'subscription' : name === 'finishBackupFlush' ? 'acknowledgment' : 'request' })),
});

const server = await createBikeMcpServer({ store: {
  config: { mode: 'readonly' },
  async load() { return { workspace: { documents: [] } }; },
  async status() { throw new Error('manifest extraction only'); },
}, version: productVersion });
const client = new Client({ name: 'bike-mygo-contract-extractor', version: productVersion });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
  const resources = (await client.listResources()).resources;
  const resourceTemplates = (await client.listResourceTemplates()).resourceTemplates;
  const prompts = (await client.listPrompts()).prompts;
  assert.equal(tools.length, 15);
  assert.equal(prompts.length, 5);
  await output('desktop-mygo/internal/contracts/mcp-manifest.json', { tools, resources, resourceTemplates, prompts, templates: BIKE_TEMPLATES });
} finally {
  await client.close();
  await server.close();
}
console.log(`MyGO contracts ${write ? 'generated' : 'verified'} against shared limits, 36 bridge members, 14 tools + Live status, ${writeCases.length} write vectors, resources and 5 prompts.`);
