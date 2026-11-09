import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson } from '../shared/bike-operations.mjs';
import { buildWorkspaceIndex, migrateWorkspace } from './bike-core.mjs';
import { assertWorkspaceBudget } from '../shared/bike-limits.mjs';

export const defaultLiveDiscoveryPath = () => path.join(os.homedir(), 'Library', 'Application Support', 'bike', 'live-mcp.json');
export const createLiveWorkspaceStore = async ({ discoveryPath = process.env.BIKE_LIVE_DISCOVERY ?? defaultLiveDiscoveryPath(), clientName = 'Bike MCP stdio' } = {}) => {
  const stats = await fs.lstat(discoveryPath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || stats.size > 4096) throw new Error('Live 发现文件权限无效，请在应用中重新启用服务');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new Error('Live 发现文件不属于当前用户');
  const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
  if (discovery.protocol !== 2 || typeof discovery.socketPath !== 'string' || typeof discovery.token !== 'string' || !/^[a-f0-9]{64}$/.test(discovery.token)) throw new Error('Live 发现协议无效');
  const socket = net.createConnection(discovery.socketPath);
  const pending = new Map();
  let buffer = Buffer.alloc(0), closed = false;
  const fail = () => { closed = true; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Live 已断开，请在应用中检查授权后重新连接')); } pending.clear(); };
  socket.on('error', fail); socket.on('close', fail);
  socket.on('data', (chunk) => {
    if (buffer.length + chunk.length > 80 * 1024 * 1024) { socket.destroy(); return; }
    buffer = Buffer.concat([buffer, chunk]);
    let newline;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const raw = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1);
      let response;
      try { response = JSON.parse(raw.toString('utf8')); } catch { socket.destroy(); return; }
      const request = pending.get(response.id);
      if (!request) continue;
      clearTimeout(request.timer); pending.delete(response.id);
      if (response.ok) request.resolve(response.result); else request.reject(new Error(response.error ?? 'Live 请求失败'));
    }
  });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const rpc = (method, payload = {}) => new Promise((resolve, reject) => {
    if (closed || socket.destroyed) { reject(new Error('Live 已断开')); return; }
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Live 请求超时，请查询回执后重试')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.write(JSON.stringify({ id, token: discovery.token, method, payload, clientName }) + '\n');
  });
  const config = { mode: 'readonly', transport: 'live', workspacePath: '', debug: false };
  const load = async () => {
    const result = await rpc('snapshot');
    const workspace = result.workspace;
    assertWorkspaceBudget(workspace);
    if (workspace?.version !== 3 || !Array.isArray(workspace.documents)) throw new Error("Live 工作区格式无效");
    config.mode = result.writable ? 'write' : 'readonly';
    return { workspace, index: buildWorkspaceIndex(workspace), revision: result.revision, workspaceId: result.workspaceId,
      workspacePath: '', workspacePathDisplay: '运行中的 Bike 工作区', workspacePathIsRedacted: true,
      file: { size: Buffer.byteLength(JSON.stringify(workspace)), modifiedAt: result.savedAt }, config };
  };
  return { config, load, status: (requestId) => rpc('status', { requestId }), close: () => socket.destroy(),
    mutate: async ({ operation, expectedRevision, dryRun = true, reason = '', writeTimestamp, requestId, command, apply }) => {
      const { dryRun: ignoredDryRun, requestId: ignoredRequestId, ...input } = command ?? {};
      const clientDigest = createHash('sha256').update(canonicalJson({ operation, expectedRevision, input })).digest('hex');
      if (requestId && dryRun === false) {
        const prior = await rpc('status', { requestId });
        if (['pending', 'committed', 'rejected', 'invalidated'].includes(prior.status) && prior.clientDigest) {
          if (prior.clientDigest !== clientDigest) throw new Error('相同请求身份携带了不同内容');
          return { ...prior, requestId, applied: prior.status === 'committed' };
        }
      }
      const current = await load();
      if (current.revision !== expectedRevision) throw new Error('Live revision 已变化，请重新读取');
      const at = writeTimestamp || new Date().toISOString();
      const draft = structuredClone(current.workspace);
      const preview = apply(draft, { now: at, current });
      assertWorkspaceBudget(draft);
      const id = requestId || randomUUID();
      if (dryRun === false && !requestId) throw new Error('Live 写入需要 dry-run 返回的 requestId，以便查询和安全重试');
      const result = await rpc('proposal', { requestId: id, operation, expectedRevision, workspaceId: current.workspaceId,
        candidate: draft, clientDigest, reason, dryRun: dryRun !== false });
      return { ...preview, ...result, requestId: id, applied: false, dryRun: dryRun !== false,
        confirmationArgs: { ...preview.confirmationArgs, expectedRevision, dryRun: false, requestId: id, writeTimestamp: at, reason } };
    },
  };
};
