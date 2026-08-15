import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  pipeWebBodyToNodeResponse,
  parsePositiveInteger,
  readNodeRequestBody,
  RequestBodyTooLargeError,
  requireApiKey,
  writeWebResponseToNodeResponse,
} from '../server-utils.js';

class FakeNodeResponse extends EventEmitter {
  constructor(writeImpl) {
    super();
    this.destroyed = false;
    this.writableEnded = false;
    this.writes = [];
    this.writeImpl = writeImpl;
    this.statusCode = null;
    this.headers = null;
  }

  write(chunk) {
    this.writes.push(Buffer.from(chunk));
    return this.writeImpl?.(this.writes.length, this) ?? true;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(chunk) {
    if (chunk) this.writes.push(Buffer.from(chunk));
    this.writableEnded = true;
  }
}

test('requires an explicit non-default API key and validates positive integers', () => {
  assert.throws(() => requireApiKey(undefined), /explicitly set/);
  assert.throws(() => requireApiKey('freebuff-default-key'), /explicitly set/);
  assert.equal(requireApiKey('  test-api-key  '), 'test-api-key');
  assert.equal(parsePositiveInteger(undefined, 123, 'LIMIT'), 123);
  assert.equal(parsePositiveInteger('456', 123, 'LIMIT'), 456);
  assert.throws(() => parsePositiveInteger('0', 123, 'LIMIT'), /positive integer/);
});

test('rejects declared and streamed request bodies above the configured limit', async () => {
  const declared = new PassThrough();
  declared.headers = { 'content-length': '11' };
  await assert.rejects(
    readNodeRequestBody(declared, 10),
    (error) => error instanceof RequestBodyTooLargeError && error.limit === 10,
  );
  declared.destroy();

  const streamed = new PassThrough();
  streamed.headers = {};
  const pending = readNodeRequestBody(streamed, 10);
  streamed.write(Buffer.alloc(6));
  streamed.write(Buffer.alloc(5));
  await assert.rejects(
    pending,
    (error) => error instanceof RequestBodyTooLargeError && error.limit === 10,
  );
  streamed.destroy();
});

test('preserves multiple Set-Cookie values when bridging a web response', async () => {
  const headers = new Headers({ 'x-test': 'present' });
  headers.append('set-cookie', 'session=test-session; Path=/admin; HttpOnly');
  headers.append('set-cookie', 'csrf=test-csrf; Path=/admin; SameSite=Strict');
  const response = new Response(null, { status: 204, headers });
  const nodeResponse = new FakeNodeResponse();

  await writeWebResponseToNodeResponse(response, nodeResponse);

  assert.equal(nodeResponse.statusCode, 204);
  assert.equal(nodeResponse.headers['x-test'], 'present');
  assert.deepEqual(nodeResponse.headers['set-cookie'], [
    'session=test-session; Path=/admin; HttpOnly',
    'csrf=test-csrf; Path=/admin; SameSite=Strict',
  ]);
  assert.equal(nodeResponse.writableEnded, true);
});

test('waits for response drain before writing the next stream chunk', async () => {
  const response = new FakeNodeResponse((writeCount, nodeResponse) => {
    if (writeCount !== 1) return true;
    setTimeout(() => nodeResponse.emit('drain'), 25);
    return false;
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      controller.enqueue(new TextEncoder().encode('second'));
      controller.close();
    },
  });
  const started = Date.now();

  assert.equal(await pipeWebBodyToNodeResponse(body, response), true);
  assert.ok(Date.now() - started >= 20, 'second write must wait for drain');
  assert.deepEqual(response.writes.map((chunk) => chunk.toString()), ['first', 'second']);
});

test('cancels the upstream web stream when the client disconnects', async () => {
  let cancelReason = null;
  const response = new FakeNodeResponse((_writeCount, nodeResponse) => {
    setTimeout(() => {
      nodeResponse.destroyed = true;
      nodeResponse.emit('close');
    }, 10);
    return false;
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });

  assert.equal(await pipeWebBodyToNodeResponse(body, response), false);
  assert.equal(cancelReason, 'client disconnected');
});

test('cancels the upstream web stream when a downstream write fails', async () => {
  let cancelReason = null;
  const response = new FakeNodeResponse(() => {
    throw new Error('downstream write failed');
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });

  await assert.rejects(pipeWebBodyToNodeResponse(body, response), /downstream write failed/);
  assert.equal(cancelReason, 'client disconnected');
});
