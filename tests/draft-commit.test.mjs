import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppCallback } from './helpers/typescript.mjs';
import { loadTypescript } from './helpers/typescript.mjs';

for (const busy of ['operationCommitRef','cleanupBusyRef','updateInstallRef']) {
  test(`${busy} preserves uncommitted Markdown input`, () => {
    const workspace = {version:3,activeDocumentId:'doc',documents:[]};
    const bindings = {
      workspaceRef:{current:workspace}, operationCommitRef:{current:false},
      cleanupBusyRef:{current:false}, updateInstallRef:{current:false},
      showNotice:()=>{}, markdownParseTimerRef:{current:null},
      markdownDraftRef:{current:{documentId:'doc',value:'unsaved draft',dirty:true}},
    };
    bindings[busy].current = true;
    bindings.commitWorkspace = loadAppCallback('commitWorkspace',bindings);
    loadAppCallback('flushMarkdownDraft',bindings)();
    assert.equal(bindings.workspaceRef.current,workspace);
    assert.equal(bindings.markdownDraftRef.current.dirty,true);
    assert.equal(bindings.markdownDraftRef.current.value,'unsaved draft');
  });
}

test('the structured flush commits a focused title without blurring or recursively flushing', () => {
  const workspace = { version:3, activeDocumentId:'doc', documents:[{id:'doc',title:'before'}] };
  class Input {
    value = 'title draft';
    matches() { return true; }
    blur() { throw new Error('must not blur'); }
  }
  let called;
  const element = new Input();
  const bindings = {
    document:{activeElement:element}, HTMLInputElement:Input,
    workspaceRef:{current:workspace},
    updateTitle(value, _options, fromFlush) { called={value,fromFlush}; return {...workspace,documents:[{id:'doc',title:value}]}; },
  };
  const saved = loadAppCallback('flushFocusedStructuredInput',bindings)();
  assert.deepEqual(called,{value:'title draft',fromFlush:true});
  assert.equal(saved.documents[0].title,'title draft');
});

test('an inspector acknowledgement only clears a draft already present in the workspace', () => {
  const workspace = {activeDocumentId:'doc',documents:[{id:'doc',nodes:[{id:'n',note:'before',children:[]}]}]};
  const bindings = {
    workspaceRef:{current:workspace},
    inspectorNoteDraftRef:{current:{nodeId:'n',value:'unsaved',baseNote:'before',dirty:true}},
    findNode:loadTypescript('src/tree.ts').findNode,
  };
  const acknowledge = loadAppCallback('handleInspectorNoteCommit',bindings);
  assert.equal(acknowledge('n','unsaved'),false);
  assert.equal(bindings.inspectorNoteDraftRef.current.dirty,true);
  workspace.documents[0].nodes[0].note='unsaved';
  assert.equal(acknowledge('n','unsaved'),true);
  assert.equal(bindings.inspectorNoteDraftRef.current.dirty,false);
});
