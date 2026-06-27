import {
  SyncConflictError,
  SyncNotFoundError,
  SyncValidationError,
} from "./sync-store.mjs";

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

export const sendJson = (response, statusCode, payload, headers = {}) => {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(payload));
};

export const methodNotAllowed = (response, allow, headers = {}) => {
  response.writeHead(405, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    Allow: allow,
    ...headers,
  });
  response.end("Method Not Allowed");
};

export const readJsonRequestBody = (request, maxBytes) =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        request.destroy();
        reject(new SyncValidationError("请求体过大"));
      }
    });
    request.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new SyncValidationError("请求体不是有效 JSON"));
      }
    });
    request.on("error", reject);
  });

export const handleSyncError = (response, error, headers = {}) => {
  if (error instanceof SyncConflictError) {
    sendJson(response, 409, {
      error: "revision_conflict",
      message: error.message,
      currentRevision: error.currentRevision,
    }, headers);
    return true;
  }
  if (error instanceof SyncValidationError) {
    sendJson(response, 400, {
      error: "invalid_request",
      message: error.message,
    }, headers);
    return true;
  }
  if (error instanceof SyncNotFoundError) {
    sendJson(response, 404, {
      error: "not_found",
      message: error.message,
    }, headers);
    return true;
  }
  return false;
};

export const handleSyncApi = async (
  request,
  response,
  config,
  syncStore,
  { headers = {} } = {},
) => {
  const url = new URL(request.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);

  if (request.method === "GET" && pathname === "/api/sync/manifest") {
    sendJson(response, 200, syncStore.getManifest(), headers);
    return;
  }

  if (pathname === "/api/sync/manifest") {
    if (request.method !== "PATCH") {
      methodNotAllowed(response, "GET, PATCH", headers);
      return;
    }
    try {
      const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
      sendJson(response, 200, syncStore.patchManifest({
        expectedRevision: body.expectedRevision,
        activeDocumentId: body.activeDocumentId,
        documentOrder: body.documentOrder,
      }), headers);
    } catch (error) {
      if (!handleSyncError(response, error, headers)) throw error;
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/documents") {
    sendJson(response, 200, { documents: syncStore.getManifest().documents }, headers);
    return;
  }

  const operationsMatch = pathname.match(/^\/api\/documents\/([^/]+)\/operations$/);
  if (operationsMatch) {
    const id = operationsMatch[1];
    try {
      if (request.method === "GET") {
        sendJson(response, 200, syncStore.getDocumentOperations({
          id,
          after: url.searchParams.get("after"),
        }), headers);
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
        sendJson(response, 200, syncStore.appendDocumentOperations({
          id,
          baseRevision: body.baseRevision,
          actorId: body.actorId,
          operations: body.operations,
        }), headers);
        return;
      }
    } catch (error) {
      if (!handleSyncError(response, error, headers)) throw error;
      return;
    }
    methodNotAllowed(response, "GET, POST", headers);
    return;
  }

  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  if (!documentMatch) {
    sendJson(response, 404, { error: "not_found", message: "API route not found" }, headers);
    return;
  }

  const id = documentMatch[1];
  try {
    if (request.method === "GET") {
      const result = syncStore.getDocument(id);
      if (!result) {
        sendJson(response, 404, { error: "not_found", message: "Document not found" }, headers);
        return;
      }
      if (result.deletedAt) {
        sendJson(response, 410, {
          error: "document_deleted",
          revision: result.revision,
          deletedAt: result.deletedAt,
        }, headers);
        return;
      }
      sendJson(response, 200, {
        revision: result.revision,
        document: result.document,
      }, headers);
      return;
    }

    if (request.method === "PUT") {
      const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
      const result = syncStore.putDocument({
        id,
        expectedRevision: body.expectedRevision,
        document: body.document,
      });
      sendJson(response, 200, {
        revision: result.revision,
        document: result.document,
      }, headers);
      return;
    }

    if (request.method === "DELETE") {
      const body = await readJsonRequestBody(request, config.sync.maxBodyBytes);
      sendJson(response, 200, syncStore.deleteDocument({
        id,
        expectedRevision: body.expectedRevision,
      }), headers);
      return;
    }
  } catch (error) {
    if (!handleSyncError(response, error, headers)) throw error;
    return;
  }

  methodNotAllowed(response, "GET, PUT, DELETE", headers);
};
