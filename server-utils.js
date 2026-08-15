import { Buffer } from 'node:buffer';

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'RequestBodyTooLargeError';
    this.limit = limit;
  }
}

export function requireApiKey(value) {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (!apiKey || apiKey === 'freebuff-default-key') {
    throw new Error('FREEBUFF_API_KEY must be explicitly set to a non-default value');
  }
  return apiKey;
}

export function parsePositiveInteger(value, defaultValue, name) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const parsed = Number(String(value).trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function readNodeRequestBody(nodeRequest, maxBytes) {
  const contentLength = Number(nodeRequest.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    nodeRequest.pause();
    return Promise.reject(new RequestBodyTooLargeError(maxBytes));
  }

  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;

    const cleanup = () => {
      nodeRequest.off('data', onData);
      nodeRequest.off('end', onEnd);
      nodeRequest.off('aborted', onAborted);
      nodeRequest.off('error', onError);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        nodeRequest.pause();
        fail(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolvePromise(Buffer.concat(chunks, total));
    };
    const onAborted = () => fail(new Error('client aborted request body'));
    const onError = (error) => fail(error);

    nodeRequest.on('data', onData);
    nodeRequest.once('end', onEnd);
    nodeRequest.once('aborted', onAborted);
    nodeRequest.once('error', onError);
  });
}

function waitForDrainOrClose(nodeResponse) {
  if (nodeResponse.destroyed) return Promise.resolve(false);
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      nodeResponse.off('drain', onDrain);
      nodeResponse.off('close', onClose);
      nodeResponse.off('error', onError);
    };
    const finish = (drained) => {
      cleanup();
      resolvePromise(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    nodeResponse.once('drain', onDrain);
    nodeResponse.once('close', onClose);
    nodeResponse.once('error', onError);
  });
}

export async function pipeWebBodyToNodeResponse(webBody, nodeResponse) {
  const reader = webBody.getReader();
  let completed = false;
  let cancelPromise = null;

  const cancelReader = () => {
    if (!cancelPromise) {
      cancelPromise = reader.cancel('client disconnected').catch(() => {});
    }
    return cancelPromise;
  };
  const onClose = () => {
    if (!completed && !nodeResponse.writableEnded) void cancelReader();
  };
  nodeResponse.once('close', onClose);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      if (nodeResponse.destroyed) break;
      if (value && !nodeResponse.write(Buffer.from(value))) {
        const drained = await waitForDrainOrClose(nodeResponse);
        if (!drained) break;
      }
    }
  } finally {
    nodeResponse.off('close', onClose);
    if (!completed) await cancelReader();
    if (cancelPromise) await cancelPromise;
    reader.releaseLock();
  }

  return completed;
}

export async function writeWebResponseToNodeResponse(webResponse, nodeResponse) {
  const headers = {};
  for (const [name, value] of webResponse.headers.entries()) {
    if (name.toLowerCase() !== 'set-cookie') headers[name] = value;
  }
  const cookies = typeof webResponse.headers.getSetCookie === 'function'
    ? webResponse.headers.getSetCookie()
    : [];
  if (cookies.length > 0) headers['set-cookie'] = cookies;

  nodeResponse.writeHead(webResponse.status, headers);
  if (webResponse.body) {
    await pipeWebBodyToNodeResponse(webResponse.body, nodeResponse);
  }
  if (!nodeResponse.writableEnded && !nodeResponse.destroyed) nodeResponse.end();
}
