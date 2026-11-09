import assert from 'node:assert/strict';
import test from 'node:test';
import * as knowledge from '../shared/bike-knowledge.mjs';
import * as markdown from '../shared/bike-markdown.mjs';
import * as network from '../shared/bike-network.mjs';
import * as limits from '../shared/bike-limits.mjs';
import * as attachments from '../shared/bike-attachments.mjs';
import { readFile } from 'node:fs/promises';

test('all shared runtime exports have matching declared public names', async () => {
  for (const [name, runtime] of Object.entries({ 'bike-knowledge': knowledge, 'bike-markdown': markdown, 'bike-network': network, 'bike-limits': limits, 'bike-attachments': attachments })) {
    const declaration = await readFile(new URL(`../shared/${name}.d.mts`, import.meta.url), 'utf8');
    const names = new Set([...declaration.matchAll(/export (?:declare )?(?:function|const|class) (\w+)/gu)].map((match) => match[1]));
    assert.deepEqual(Object.keys(runtime).sort(), [...names].sort(), name);
  }
});
