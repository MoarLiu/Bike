import path from 'node:path';
import fs from 'node:fs/promises';
import { createSyncStore } from '../server/sync-store.mjs';

const argument = process.argv.find(value => value.startsWith('--database='));
if (!argument) throw new Error('用法：node scripts/maintain-assets.mjs --database=/path/bike-sync.sqlite [--apply]。请先备份并停止服务；默认仅报告候选。');
const database = path.resolve(argument.slice('--database='.length));
const metadata = await fs.lstat(database);
if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 100) throw new Error('维护只接受已存在的普通 SQLite 数据库文件');
const handle = await fs.open(database, 'r');
try {
  const header = Buffer.alloc(16);
  await handle.read(header, 0, header.length, 0);
  if (header.toString('ascii') !== 'SQLite format 3\u0000') throw new Error('数据库格式无效，已停止维护');
} finally { await handle.close(); }
const store = await createSyncStore(database);
try {
  const result = await store.collectUnusedAssets({ apply: process.argv.includes('--apply') });
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); }
