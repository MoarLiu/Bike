import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTypescript} from './helpers/typescript.mjs';
const {outlineWindow}=loadTypescript('src/virtualOutline.ts');
test('a 20,000 row outline renders a bounded viewport and pins active/dragged rows',()=>{
  const offsets=Array.from({length:20001},(_,i)=>i*32);
  const visible=outlineWindow(offsets,10000*32,960,[2,19999]);
  assert.ok(visible.length<60);
  assert.ok(visible.includes(2)&&visible.includes(19999));
  assert.ok(visible.includes(10000)&&visible.includes(10029));
});
test('variable row heights produce a visible range containing the viewport',()=>{
  const offsets=[0,32,500,532,900,932];
  const visible=outlineWindow(offsets,450,70);
  assert.ok(visible.includes(1)&&visible.includes(2));
});
