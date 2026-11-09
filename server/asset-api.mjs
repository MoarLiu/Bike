import { OPERATION_LIMITS } from '../shared/bike-operations.mjs';
import { readJsonRequestBody, sendJson } from './sync-api.mjs';
export const handleAssetApi = async (request, response, store, { headers = {} } = {}) => {
  const url = new URL(request.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/v2\/assets\/([a-f0-9]{64})(?:\/(lease|chunks|finish))?$/);
  if (!match) return false;
  const assetId = `sha256:${match[1]}`, action = match[2];
  try {
    let result;
    if (request.method === 'POST' && action === 'lease') result = await store.begin(assetId, await readJsonRequestBody(request, 4096));
    else if (request.method === 'DELETE' && action === 'lease') result = await store.reset(assetId, (await readJsonRequestBody(request, 4096)).uploadId);
    else if (request.method === 'PUT' && action === 'chunks') {
      const chunks = []; let length = 0;
      if (Number(request.headers['content-length']) > OPERATION_LIMITS.attachmentChunkBytes) throw Object.assign(new Error('上传块超过 1 MiB'), { statusCode: 413 });
      for await (const chunk of request) {
        length += chunk.length;
        if (length > OPERATION_LIMITS.attachmentChunkBytes) throw Object.assign(new Error('上传块超过 1 MiB'), { statusCode: 413 });
        chunks.push(chunk);
      }
      result = await store.writeChunk(assetId, { uploadId: url.searchParams.get('uploadId'), offset: Number(url.searchParams.get('offset')), bytes: Buffer.concat(chunks, length) });
    } else if (request.method === 'POST' && action === 'finish') result = await store.finish(assetId, (await readJsonRequestBody(request, 4096)).uploadId);
    else if (request.method === 'GET' && !action) {
      const chunk = await store.openChunk(assetId, Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('length') ?? OPERATION_LIMITS.attachmentChunkBytes));
      response.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': chunk.length,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Bike-Asset-Length': chunk.byteLength });
      if (!chunk.length) { await chunk.file.close(); response.end(); return true; }
      const stream = chunk.file.createReadStream({ start: chunk.offset, end: chunk.offset + chunk.length - 1, autoClose: true });
      response.on('close', () => stream.destroy());
      stream.on('error', () => response.destroy());
      stream.pipe(response);
      return true;
    } else { sendJson(response, 405, { error: 'method_not_allowed', message: '附件方法不受支持' }, headers); return true; }
    sendJson(response, 200, result, headers);
  } catch (error) {
    sendJson(response, error.statusCode ?? (error.code === 'ENOSPC' ? 507 : 400), { error: error.code ?? 'asset_error', message: error.message }, headers);
  }
  return true;
};
