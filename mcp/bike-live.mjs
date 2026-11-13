import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { canonicalJson } from '../shared/bike-operations.mjs';
import { buildWorkspaceIndex } from './bike-core.mjs';
import { assertWorkspaceBudget } from '../shared/bike-limits.mjs';
import { createLiveCandidatePatch } from '../shared/bike-live-patch.mjs';
import { createLineBuffer } from '../electron/line-buffer.cjs';

export const defaultLiveDiscoveryPath = () => path.join(os.homedir(), 'Library', 'Application Support', 'bike', 'live-mcp.json');
export const createLiveWorkspaceStore = async ({ discoveryPath = process.env.BIKE_LIVE_DISCOVERY ?? defaultLiveDiscoveryPath(), clientName = 'Bike MCP stdio' } = {}) => {
  const stats = await fs.lstat(discoveryPath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 || stats.size > 4096) throw new Error('Live 发现文件权限无效，请在应用中重新启用服务');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new Error('Live 发现文件不属于当前用户');
  const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
  if (discovery.protocol !== 2 || typeof discovery.socketPath !== 'string' || typeof discovery.token !== 'string' || !/^[a-f0-9]{64}$/.test(discovery.token)) throw new Error('Live 发现协议无效');
  let socket = null, connecting = null, disposed = false;
  const pending = new Map();
  const connect = async () => {
    if (disposed) throw new Error('Live 连接已关闭');
    if (socket && !socket.destroyed) return socket;
    if (connecting) return connecting;
    connecting = (async () => {
      const currentStats = await fs.lstat(discoveryPath);
      const current = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
      if (!currentStats.isFile() || currentStats.isSymbolicLink() || (currentStats.mode & 0o077) ||
          (typeof process.getuid === 'function' && currentStats.uid !== process.getuid()) ||
          current.token !== discovery.token || current.socketPath !== discovery.socketPath) throw new Error('Live 授权已变化，请明确重新连接');
      const metadata = await fs.lstat(discovery.socketPath);
      const parent = await fs.lstat(path.dirname(discovery.socketPath));
      if (!metadata.isSocket() || parent.isSymbolicLink() || (parent.mode & 0o077) ||
          (typeof process.getuid === 'function' && (metadata.uid !== process.getuid() || parent.uid !== process.getuid()))) throw new Error('Live socket 权限无效');
      const connection = net.createConnection(discovery.socketPath);
      const buffer = createLineBuffer(80 * 1024 * 1024);
      const fail = () => {
        if (socket !== connection) return;
        socket = null;
        for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Live 连接中断；读取可重试，写入请先查询回执')); }
        pending.clear();
      };
      connection.on('error', fail); connection.on('close', fail);
      connection.on('data', (chunk) => {
        let lines;
        try { lines = buffer.push(chunk); } catch { connection.destroy(); return; }
        for (const raw of lines) {
          let response;
          try { response = JSON.parse(raw.toString('utf8')); } catch { connection.destroy(); return; }
          const request = pending.get(response.id);
          if (!request) continue;
          clearTimeout(request.timer); pending.delete(response.id);
          if (response.ok) request.resolve(response.result); else request.reject(new Error(response.error ?? 'Live 请求失败'));
        }
      });
      await new Promise((resolve, reject) => { connection.once('connect', resolve); connection.once('error', reject); });
      if (disposed) { connection.destroy(); throw new Error('Live 连接已关闭'); }
      socket = connection;
      return connection;
    })().catch((error) => {
      if (error.code) throw new Error('Live 已断开或授权已撤销，请在应用内检查授权后重试');
      throw error;
    }).finally(() => { connecting = null; });
    return connecting;
  };
  await connect();
  const rpc = async (method, payload = {}) => {
    const connection = await connect();
    const id = randomUUID();
    const encoded = JSON.stringify({ id, token: discovery.token, method, payload, clientName }) + '\n';
    if (Buffer.byteLength(encoded) > 80 * 1024 * 1024) throw new Error('Live 请求超过 80 MiB，请缩小修改范围；连接仍可使用');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Live 请求超时，请查询回执后重试')); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      connection.write(encoded);
    });
  };
  const config = { mode: 'readonly', transport: 'live', workspacePath: '', debug: false };
  const load = async () => {
    const result = await rpc('snapshot');
    const workspace = result.workspace;
    assertWorkspaceBudget(workspace);
    if (workspace?.version !== 3 || !Array.isArray(workspace.documents)) throw new Error("Live 工作区格式无效");
    config.mode = result.writable ? 'write' : 'readonly';
    return { workspace, index: buildWorkspaceIndex(workspace), revision: result.revision, workspaceId: result.workspaceId,
      workspacePath: '', workspacePathDisplay: '运行中的 Bike 工作区', workspacePathIsRedacted: true,
      file: { size: Buffer.byteLength(JSON.stringify(workspace)), modifiedAt: result.savedAt }, config, capabilities: result.capabilities ?? [] };
  };
  return { config, load, status: (requestId) => rpc('status', { requestId }), close: () => { disposed = true; socket?.destroy(); },
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
      const candidate = current.capabilities.includes("candidate-patch-v1")
        ? { candidatePatch: createLiveCandidatePatch(current.workspace, draft) } : { candidate: draft };
      if (!current.capabilities.includes("candidate-patch-v1") && Buffer.byteLength(JSON.stringify(candidate)) > 3.9 * 1024 * 1024)
        throw new Error("当前应用的 Live 写入容量较小，请将桌面应用升级到 2.0.1 后重试");
      const result = await rpc('proposal', { requestId: id, operation, expectedRevision, workspaceId: current.workspaceId,
        ...candidate, clientDigest, reason, dryRun: dryRun !== false });
      return { ...preview, ...result, requestId: id, applied: false, dryRun: dryRun !== false,
        confirmationArgs: { ...preview.confirmationArgs, expectedRevision, dryRun: false, requestId: id, writeTimestamp: at, reason } };
    },
  };
};
