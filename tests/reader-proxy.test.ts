import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type RequestListener } from 'node:http';
import { proxyToReader } from '../worker/handlers/proxy';
import { readerPost, readerGetBookshelf, readerLogin } from '../worker/reader-content';

async function server(t: { after: (fn: () => void) => void }, handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`;
}

test('reader 代理等响应头超时会取消上游并返回 504', async t => {
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const base = await server(t, (req, res) => { res.on('close', closed); });
  const response = await proxyToReader(new Request('http://proxy.test/reader3/searchBook'), base, { headerTimeoutMs: 100 });
  assert.equal(response.status, 504);
  assert.match((await response.json()).errorMsg, /响应超时/);
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stayed open')), 2000))]);
});

test('reader 代理传递调用方取消，不继续等待上游', async t => {
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  const base = await server(t, () => { received(); });
  const controller = new AbortController();
  const response = proxyToReader(new Request('http://proxy.test/reader3/searchBook', { signal: controller.signal }), base);
  await started;
  controller.abort();
  assert.equal((await response).status, 499);
});

test('reader 流在收到响应头后不受响应头超时限制', async t => {
  const base = await server(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    const timer = setTimeout(() => res.end('data: second\n\n'), 100);
    res.on('close', () => clearTimeout(timer));
  });
  const response = await proxyToReader(new Request('http://proxy.test/reader3/searchBookMultiSSE'), base, { headerTimeoutMs: 40 });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data: second/);
});

test('reader 流传输期间仍响应调用方取消', async t => {
  const base = await server(t, (_req, res) => { res.writeHead(200); res.write('first'); });
  const controller = new AbortController();
  const response = await proxyToReader(new Request('http://proxy.test/reader3/getBookContent', { signal: controller.signal }), base);
  const reader = response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
  controller.abort();
  await assert.rejects(reader.read());
});

test('代理区分 undici 响应头超时与连接失败，并隐藏内部地址', async t => {
  for (const [code, status] of [['UND_ERR_HEADERS_TIMEOUT', 504], ['ECONNREFUSED', 502]] as const) {
    t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed', { cause: { code } }); });
    const response = await proxyToReader(new Request('http://proxy.test/reader3/getBookshelf'), 'http://internal-reader:8080');
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /internal-reader/);
    t.mock.restoreAll();
  }
});

test('WebDAV 的 207 href 修正仍保留', async t => {
  const base = await server(t, (_req, res) => {
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    res.end('<D:href>http://reader:8080/reader3/webdav/legado/</D:href>');
  });
  const response = await proxyToReader(new Request('http://proxy.test/reader3/webdav/legado/', { method: 'PROPFIND' }), base);
  assert.equal(response.status, 207);
  assert.equal(await response.text(), '<D:href>/reader3/webdav/legado/</D:href>');
});

test('正文、书架和登录超时能说明阶段，而非通用 aborted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  for (const [operation, message] of [
    [() => readerPost('http://reader.invalid', '/getBookContent', {}), /getBookContent.*超时/],
    [() => readerGetBookshelf('http://reader.invalid'), /书架请求超时/],
    [() => readerLogin('http://reader.invalid', 'fixture', 'fixture-password'), /登录请求超时/],
  ] as const) {
    const pending = operation();
    const checked = assert.rejects(pending, message);
    t.mock.timers.tick(30_001);
    await checked;
  }
});
