const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createLineBuffer } = require('./line-buffer.cjs');
const MAX_REQUEST = 80 * 1024 * 1024;
const MAX_RESPONSE = 80 * 1024 * 1024;
const safeToken = (actual, expected) => typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

const createLiveMcpService = ({ directory, handle, onRevoke = () => {} }) => {
  let server = null, temporary = null, secret = null, grant = null;
  const clients = new Set();
  const discoveryPath = path.join(directory, 'live-mcp.json');
  const state = () => ({ enabled: Boolean(server), writable: grant?.writable === true,
    documentIds: grant?.documentIds ?? [], discoveryPath: server ? discoveryPath : null });
  let queue = Promise.resolve();
  const enqueue = (task) => { const result = queue.then(task, task); queue = result.catch(() => {}); return result; };
  const stopInternal = async () => {
    const current = server; server = null; grant = null;
    for (const socket of clients) socket.destroy();
    clients.clear();
    if (current) await new Promise((resolve) => current.close(resolve));
    if (secret) {
      try {
        const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
        if (discovery.token === secret) await fs.rm(discoveryPath, { force: true });
      } catch (error) { if (error.code !== 'ENOENT') { /* A corrupt discovery file grants no access. */ } }
    }
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    secret = null; temporary = null; onRevoke();
    return state();
  };
  const startInternal = async ({ documentIds = [], writable = false, scope = "document" }) => {
    if (!Array.isArray(documentIds) || (scope !== "workspace" && !documentIds.length) || documentIds.length > 1000 || documentIds.some((id) => typeof id !== 'string' || !id || id.length > 200)) throw new Error('请选择有效文档授权范围');
    await stopInternal();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await fs.lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Live 发现目录无效');
    await fs.chmod(directory, 0o700);
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-live-'));
    await fs.chmod(temporary, 0o700);
    const socketPath = path.join(temporary, 'bridge.sock');
    secret = crypto.randomBytes(32).toString('hex');
    grant = { scope: scope === "workspace" ? "workspace" : "document", documentIds: [...new Set(documentIds)], writable: writable === true };
    const activeSecret = secret;
    const activeGrant = grant;
    const instance = net.createServer((socket) => {
      if (clients.size >= 8) { socket.destroy(); return; }
      clients.add(socket);
      const session = { id: crypto.randomUUID(), clientName: '', connectedAt: new Date().toISOString() };
      const buffered = createLineBuffer(MAX_REQUEST);
      let inFlight = 0;
      socket.on('error', () => {});
      socket.on('close', () => clients.delete(socket));
      socket.on('data', (chunk) => {
        let lines;
        try { lines = buffered.push(chunk); } catch { socket.destroy(); return; }
        for (const line of lines) {
          let request;
          try { request = JSON.parse(line.toString('utf8')); } catch { socket.destroy(); return; }
          if (!request || typeof request !== 'object' || Array.isArray(request) || !safeToken(request.token, activeSecret) || typeof request.id !== 'string' || request.id.length > 200 || !['snapshot', 'proposal', 'status'].includes(request.method)) { socket.destroy(); return; }
          if (inFlight >= 4) { socket.write(JSON.stringify({ id: request.id, ok: false, error: 'Live 请求繁忙，请稍后重试' }) + '\n'); continue; }
          if (request.method === 'proposal' && request.payload?.dryRun === false && !activeGrant.writable) {
            socket.write(JSON.stringify({ id: request.id, ok: false, error: '当前 Live 连接只读，请在应用内明确授权写入' }) + '\n'); continue;
          }
          session.clientName = String(request.clientName ?? '').slice(0, 120);
          inFlight++;
          Promise.resolve().then(() => {
            if (server !== instance || secret !== activeSecret) throw new Error('Live 授权已撤销');
            return handle({ method: request.method, payload: request.payload ?? {}, grant: activeGrant, session: { ...session } });
          }).then((result) => {
            const encoded = JSON.stringify({ id: request.id, ok: true, result });
            if (Buffer.byteLength(encoded) > MAX_RESPONSE) throw new Error('Live 读取结果超过预算，请缩小授权范围');
            if (!socket.destroyed) {
              if (socket.writableLength + Buffer.byteLength(encoded) > MAX_RESPONSE) { socket.destroy(); return; }
              if (!socket.write(encoded + '\n')) { socket.pause(); socket.once('drain', () => socket.resume()); }
            }
          }).catch((error) => { if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, ok: false, error: error.message }) + '\n'); })
            .finally(() => inFlight--);
        }
      });
    });
    instance.on('error', () => {});
    try {
      await new Promise((resolve, reject) => { instance.once('error', reject); instance.listen(socketPath, resolve); });
      server = instance;
      await fs.chmod(socketPath, 0o600);
      const file = await fs.open(discoveryPath, 'w', 0o600);
      try { await file.chmod(0o600); await file.writeFile(JSON.stringify({ protocol: 2, socketPath, token: secret }) + '\n'); await file.sync(); }
      finally { await file.close(); }
      return state();
    } catch (error) { await stopInternal(); throw error; }
  };
  return { start: (grant) => enqueue(() => startInternal(grant)), stop: () => enqueue(stopInternal), state };
};
module.exports = { createLiveMcpService };
