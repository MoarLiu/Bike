import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as current from '../shared/bike-replica.mjs';
import { createWorkspaceOperation, applyWorkspaceOperation, initialPositions, sameOperationDocument } from '../shared/bike-operations.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11) ?? '575331f';
assert.match(baseline, /^[a-f0-9]{7,40}$/);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-legacy-reference-'));
try {
  await fs.cp(path.join(root, 'shared'), path.join(temporary, 'shared'), { recursive: true });
  for (const file of ['bike-operations.mjs', 'bike-replica.mjs']) {
    const source = execFileSync('git', ['show', `${baseline}:shared/${file}`], { cwd: root });
    await fs.writeFile(path.join(temporary, 'shared', file), source);
  }
  const old = await import(pathToFileURL(path.join(temporary, 'shared/bike-replica.mjs')));
  const at = '2026-11-13T00:00:00.000Z';
  const make = id => ({ id, text: id, note: '', checked: false, collapsed: false, color: 'plain', children: [] });
  const flat = nodes => nodes.flatMap(node => [node, ...flat(node.children)]);
  let accepted = 0, rejected = 0, mixedChecks = 0;
  const input = (id, digest, kind = 'user') => ({ requestId: id, digest, source: { kind, label: 'regression' }, at });
  for (let seed = 1; seed <= 60; seed++) {
    let before = { version: 3, activeDocumentId: 'doc', documents: [{ id: 'doc', title: 'Doc', createdAt: at, updatedAt: at, nodes: [make('a'), make('b')] }] };
    let replica = old.createReplicaState(before, `legacy-${seed}`), random = seed;
    let mixed = structuredClone(before), positions = initialPositions(mixed);
    const pick = n => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % n; };
    for (let step = 0; step < 100; step++) {
      const after = structuredClone(before), roots = after.documents[0].nodes, nodes = flat(roots), action = pick(3);
      if (action === 0 || nodes.length < 2) {
        const list = !nodes.length || pick(2) ? roots : nodes[pick(nodes.length)].children;
        list.splice(pick(list.length + 1), 0, make(`n-${seed}-${step}`));
      } else {
        const node = nodes[pick(nodes.length)], parent = nodes.find(item => item.children.includes(node)), list = parent?.children ?? roots;
        list.splice(list.indexOf(node), 1);
        if (action === 2) {
          const remaining = flat(roots), target = remaining.length && pick(2) ? remaining[pick(remaining.length)].children : roots;
          target.splice(pick(target.length + 1), 0, node);
        }
      }
      let committed;
      try { committed = old.recordReplicaCommit(replica, before, after, input(`old-${seed}-${step}`, String(step))); }
      catch {
        // Every legally constructed sequence rejected by the old engine must
        // also become saveable immediately after upgrading.
        current.recordReplicaCommit(replica, before, after, input(`repair-${seed}-${step}`, 'repair'));
        rejected++; continue;
      }
      replica = committed.replica; before = after; accepted++;
      const edit = structuredClone(before), first = flat(edit.documents[0].nodes)[0];
      if (first) first.note = 'new edit'; else edit.documents[0].title = 'empty edited';
      current.recordReplicaCommit(replica, before, edit, input(`new-${seed}-${step}`, 'new'));
      const incoming = applyWorkspaceOperation(mixed, positions, committed.operation);
      assert.equal(incoming.status, 'applied', JSON.stringify({ seed, step, conflicts: incoming.conflicts }));
      mixed = incoming.workspace; positions = incoming.positions;
      assert.ok(sameOperationDocument({ ...before.documents[0], title: mixed.documents[0].title }, mixed.documents[0]), `${seed}:${step}`);
      const next = { ...mixed, documents: [{ ...mixed.documents[0], title: `new title ${step}` }] };
      const operation = createWorkspaceOperation(mixed, next, { id: `mixed-${seed}-${step}`, actorId: 'new', clock: 10000 + step, positions, createdAt: at });
      const saved = applyWorkspaceOperation(mixed, positions, operation);
      assert.equal(saved.status, 'applied');
      mixed = saved.workspace; positions = saved.positions; mixedChecks++;
    }
  }
  const result = { baseline, acceptedLegacyStates: accepted, legacyRejectedSequencesNowSaveable: rejected,
    newEditsAfterUpgrade: 'passed', interleavedLegacyAndNewOperations: mixedChecks };
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version;
  const output = path.join(root, `output/review-${version}`);
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'legacy-stress.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
