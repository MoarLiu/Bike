import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineBuffer } from './line-buffer.cjs';

test('streaming IPC frames preserve split Unicode and coalesced messages', () => {
  const buffer = createLineBuffer(128), bytes = Buffer.from('{"text":"🙂中文"}\n{"ok":true}\n');
  const lines = [];
  for (let offset = 0; offset < bytes.length; offset += 3) lines.push(...buffer.push(bytes.subarray(offset, offset + 3)));
  assert.deepEqual(lines.map(line => JSON.parse(line)), [{ text: '🙂中文' }, { ok: true }]);
});

test('IPC budgets apply to an unfinished frame across chunk boundaries', () => {
  const buffer = createLineBuffer(10);
  buffer.push(Buffer.from('123456'));
  assert.throws(() => buffer.push(Buffer.from('78901')), /budget/);
});
