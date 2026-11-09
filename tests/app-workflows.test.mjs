import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppCallback, loadTypescript } from './helpers/typescript.mjs';
import { acceptProposalGroups } from '../shared/bike-proposals.mjs';

const workflow = loadTypescript('src/knowledgeWorkflow.ts');
const { migrateWorkspace } = loadTypescript('src/migrations.ts');
const { sameDocumentContent } = loadTypescript('src/documentSignature.ts');
const outputs = {
  summary: { text: '根据资料整理的摘要，未明确项待确认' },
  reorder: { moves: [{ nodeId: 'b', parentId: null, afterId: null, reason: '先列背景' }] },
  dedupe: { merges: [{ keepId: 'a', removeIds: ['b'], reason: '内容重复，保留两项独有信息' }] },
  tasks: { tasks: [{ text: '第一项任务' }, { text: '第二项任务' }] },
  relations: { relations: [{ fromNodeId: 'a', toNodeId: 'b', label: '支持', reason: '资料中的关联' }] },
  'prd-template': { title: 'PRD 草稿', nodes: [{ text: '目标与范围待确认', children: [] }] },
  'tasks-template': { title: '任务草稿', nodes: [{ text: '实施与验收待确认', children: [] }] },
  'meeting-template': { title: '会议纪要草稿', nodes: [{ text: '结论与责任人待确认', children: [] }] },
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { resolve, promise };
};
const fixture = (action) => {
  const workspace = migrateWorkspace({ version: 3, activeDocumentId: 'doc', documents: [{
    id: 'doc', title: '资料', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    nodes: [{ id: 'a', text: '主题 A', children: [] }, { id: 'b', text: '主题 B', children: [] }],
  }] });
  const started = deferred(), answer = deferred(), proposals = [], notices = [];
  const bindings = {
    ...workflow, sameDocumentContent, Error,
    aiRequestRef: { current: null }, workspaceRef: { current: workspace },
    activeNodeIdRef: { current: null }, knowledgeWholeDocument: true,
    knowledgeAction: action, templateAudience: '个人', summaryDestination: 'child',
    ensureOperationWorkspace: async () => workspace,
    ensureAiConfig: () => ({ model: 'deterministic-test' }),
    requestAiJson: async (_config, _instruction, context, { signal }) => {
      started.resolve({ context, signal });
      return answer.promise;
    },
    flushPendingEdits: () => bindings.workspaceRef.current,
    setAiBusyKey: () => {}, setShowKnowledgeWorkflow: () => {},
    enqueueProposal: (proposal) => proposals.push(proposal),
    showNotice: (notice) => notices.push(notice),
  };
  return { bindings, workspace, started, answer, proposals, notices,
    run: loadAppCallback('runKnowledgeWorkflow', bindings),
    cancel: loadAppCallback('cancelAiAction', bindings) };
};

for (const [action, output] of Object.entries(outputs)) {
  test(`${action} uses the actual application proposal, rejection, stale, cancellation and invalid-output paths`, async () => {
    const accepted = fixture(action), before = JSON.stringify(accepted.workspace);
    const running = accepted.run();
    await accepted.started.promise;
    accepted.answer.resolve(output);
    await running;
    assert.equal(accepted.proposals.length, 1);
    assert.equal(JSON.stringify(accepted.workspace), before);
    const proposal = accepted.proposals[0];
    const selected = proposal.groups.map((group) => group.id);
    const next = acceptProposalGroups(accepted.workspace, proposal, selected);
    assert.notEqual(JSON.stringify(next), before);
    assert.throws(() => acceptProposalGroups(accepted.workspace, proposal, selected, proposal.expiresAt), /过期/);
    assert.throws(() => acceptProposalGroups(accepted.workspace, proposal, []), /请选择/);
    if (action === 'tasks') {
      const partial = acceptProposalGroups(accepted.workspace, proposal, [selected[1]]);
      assert.equal(partial.documents[0].nodes.at(-1).text, '第二项任务');
      assert.equal(partial.documents[0].nodes.length, accepted.workspace.documents[0].nodes.length + 1);
    }
    Object.assign(accepted.bindings, {
      proposal, liveRequestStatusesRef: { current: new Map() },
      proposalRegistryRef: { current: new Map([[proposal.id, { proposal }]]) },
      setProposals: (update) => { accepted.proposals.splice(0, accepted.proposals.length, ...update(accepted.proposals)); },
      setProposalError: () => {},
    });
    loadAppCallback('rejectProposal', accepted.bindings)();
    assert.equal(accepted.proposals.length, 0);
    assert.equal(accepted.bindings.liveRequestStatusesRef.current.get(proposal.id).status, 'rejected');
    assert.equal(JSON.stringify(accepted.workspace), before);

    const stale = fixture(action), staleRunning = stale.run();
    await stale.started.promise;
    const changed = structuredClone(stale.workspace);
    changed.documents[0].nodes[0].note = '请求期间新增的编辑';
    stale.bindings.workspaceRef.current = changed;
    stale.answer.resolve(output);
    await staleRunning;
    assert.equal(stale.proposals.length, 0);
    assert.match(stale.notices.at(-1), /内容已变化/);
    assert.equal(stale.bindings.workspaceRef.current.documents[0].nodes[0].note, '请求期间新增的编辑');

    const switched = fixture(action), switchedRunning = switched.run();
    await switched.started.promise;
    const other = { ...structuredClone(switched.workspace.documents[0]), id: 'other', title: '另一文档', nodes: [] };
    switched.bindings.workspaceRef.current = { ...switched.workspace, activeDocumentId: other.id,
      documents: [...switched.workspace.documents, other] };
    switched.answer.resolve(output);
    await switchedRunning;
    assert.equal(switched.proposals.length, 1);
    const originalTarget = switched.proposals[0];
    assert.equal(typeof originalTarget.baselines.doc, 'string');
    const switchedResult = acceptProposalGroups(switched.bindings.workspaceRef.current, originalTarget, originalTarget.groups.map((group) => group.id));
    assert.equal(JSON.stringify(switchedResult.documents.find((document) => document.id === other.id)), JSON.stringify(other));

    const cancelled = fixture(action), cancelledRunning = cancelled.run();
    const request = await cancelled.started.promise;
    cancelled.cancel();
    assert.equal(request.signal.aborted, true);
    cancelled.answer.resolve(output);
    await cancelledRunning;
    assert.equal(cancelled.proposals.length, 0);
    assert.equal(cancelled.bindings.aiRequestRef.current, null);
    assert.equal(JSON.stringify(cancelled.workspace), before);

    const invalid = fixture(action), invalidRunning = invalid.run();
    await invalid.started.promise;
    invalid.answer.resolve(null);
    await invalidRunning;
    assert.equal(invalid.proposals.length, 0);
    assert.match(invalid.notices.at(-1), /结构化对象/);
    assert.equal(invalid.bindings.aiRequestRef.current, null);
  });
}
