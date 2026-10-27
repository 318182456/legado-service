import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkBookSource } from '../worker/handlers/availability-check';
import { extractSearchBooks } from '../worker/handlers/source-rules';

const source = { searchUrl: '/search?q={{key}}', ruleSearch: { bookList: '.book', name: 'a@text', bookUrl: 'a@href' } };
const check = (value: any = source, options: any = {}) => checkBookSource(JSON.stringify(value), 'https://source.invalid', { retries: 0, ...options });
const reply = (data: any) => Response.json({ isSuccess: true, data });

test('带登录配置直接拒绝，不请求源站；数组配置不是书源', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw Error('不应请求'); });
  assert.equal((await check({ ...source, loginUrl: 'https://source.invalid/login' })).reason, 'login-required');
  assert.equal((await check([])).reason, 'invalid-json');
});

test('静态 HTML 必须真实匹配元素，并解析出书名和 HTTP 书籍地址', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<div class="book"><a href="/book/1">我的书</a></div>'));
  assert.equal((await check()).verdict, 'available');
  t.mock.method(globalThis, 'fetch', async () => new Response('<!-- .book --> <script>const x="book"</script><a href="/">首页</a>'));
  assert.equal((await check()).verdict, 'skipped');
  t.mock.method(globalThis, 'fetch', async () => new Response('<div class="book"><a href="javascript:void(0)">广告</a></div>'));
  assert.equal((await check()).verdict, 'unavailable');
});

test('默认 class/tag 链、排除索引及备选规则按实际节点工作', async () => {
  const rules = { bookList: 'class.missing||class.grid@tag.tr!0', name: 'tag.td.0@a@text', bookUrl: 'tag.a.0@href' };
  const result = await extractSearchBooks('<table class="grid"><tr><td>标题</td></tr><tr><td><a href="/b/1">书名</a></td></tr></table>', 'text/html', rules, 'https://source.invalid/search');
  assert.deepEqual(result.books, [{ name: '书名', url: 'https://source.invalid/b/1' }]);
});

test('短 JSON 可通过，通配符正确逐项取值；错误对象不能被视为可用', async t => {
  const src = { searchUrl: '/search', ruleSearch: { bookList: '$.data[*].books[*]', name: '$.name', bookUrl: '$.url' } };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ books: [{ name: '书', url: '/b/1' }] }] }));
  assert.equal((await check(src)).verdict, 'available');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '服务异常' }));
  assert.equal((await check(src)).verdict, 'skipped');
});

test('无搜索、动态规则、非 UTF-8 请求和不支持的 XPath 保留为待确认', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html><body>首页</body></html>'));
  for (const src of [
    { ...source, searchUrl: '' }, { ...source, searchUrl: '@js:someCode()' },
    { ...source, searchUrl: '/s,{"charset":"gbk"}' },
    { ...source, ruleSearch: { ...source.ruleSearch, bookList: '//div[@class="book"]' } },
  ]) assert.equal((await check(src)).verdict, 'skipped');
});

test('限流、防护和超时不误判为失效，401 要求登录则确认不可用', async t => {
  for (const [status, content, reason, verdict] of [
    [429, '', 'rate-limited', 'skipped'], [503, '<title>Just a moment</title>', 'anti-bot', 'skipped'],
    [401, '', 'login-required', 'unavailable'], [500, 'server error', 'server-error', 'skipped'],
  ] as const) {
    t.mock.method(globalThis, 'fetch', async () => new Response(content, { status }));
    const result = await check();
    assert.equal(result.reason, reason); assert.equal(result.verdict, verdict);
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timeout', 'TimeoutError'); });
  assert.equal((await check()).verdict, 'skipped');
});

test('表单已有百分号编码不被再次编码，JSON 参数中的引号保持合法', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const params = new URLSearchParams(init.body as string);
    assert.equal(params.get('fixed'), 'a b'); assert.equal(params.get('keyword'), '书&名');
    return Response.json([]);
  });
  await check({ ...source, searchUrl: '/s,{"method":"POST","body":"fixed=a%20b&keyword={{key}}"}' }, { keyword: '书&名' });
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(JSON.parse(init.body as string).q, '带"引号'); return Response.json([]);
  });
  await check({ ...source, searchUrl: '/s,{"method":"POST","body":{"q":"{{key}}"}}' }, { keyword: '带"引号' });
});

test('超过读取上限的 JSON 不因截断被判失效', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"data":"' + 'x'.repeat(1024 * 1024) + '"}'));
  const result = await check();
  assert.equal(result.verdict, 'skipped'); assert.equal(result.reason, 'body-too-large');
});

test('reader 执行动态书源，并确认搜索、目录和正文；试读使用 cache=1', async t => {
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname; paths.push(path);
    const payload = JSON.parse(init.body as string);
    assert.equal(payload.bookSource.searchUrl, '@js:dynamicRequest()');
    if (path.endsWith('searchBook')) return reply([{ name: '书', bookUrl: 'https://source.invalid/book' }]);
    if (path.endsWith('getChapterList')) return reply([{ title: '第一章', url: '/chapter/1', isVolume: false }]);
    assert.equal(payload.cache, 1); assert.equal(payload.index, 0);
    return reply('这是一段用于验证的小说正文，包含足够多的内容，可以确认正文解析成功。');
  });
  const result = await check({ ...source, searchUrl: '@js:dynamicRequest()' }, { depth: 'content', reader: { url: 'https://reader.invalid' } });
  assert.equal(result.reason, 'content-verified');
  assert.deepEqual(paths, ['/reader3/searchBook', '/reader3/getChapterList', '/reader3/getBookContent']);
});

test('reader 自身认证失败不会误禁书源，源站登录失败则禁用', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  const options = { reader: { url: 'https://reader.invalid' } };
  assert.equal((await check(source, options)).reason, 'reader-unavailable');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ isSuccess: false, errorMsg: '请登录后使用' }));
  assert.equal((await check(source, options)).reason, 'reader-unavailable');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ isSuccess: false, errorMsg: '请先登录后使用' }));
  assert.equal((await check(source, options)).reason, 'login-required');
});

test('reader 空搜索换关键词仍为空时待确认；只测搜索时不谎称正文可读', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return reply([]); });
  const options = { reader: { url: 'https://reader.invalid' }, depth: 'search' };
  assert.equal((await check(source, options)).verdict, 'skipped'); assert.equal(calls, 2);
  t.mock.method(globalThis, 'fetch', async () => reply([{ name: '书名', bookUrl: '/book' }]));
  assert.equal((await check(source, options)).reason, 'search-verified');
});

test('正文检测跳过分卷/付费章节，单本无免费章节不能判整个源失效', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('searchBook')) return reply([{ name: '书', bookUrl: '/book' }]);
    return reply([{ url: '/volume', isVolume: true }, { url: '/vip', isVip: true }]);
  });
  const result = await check(source, { reader: { url: 'https://reader.invalid' }, depth: 'content' });
  assert.equal(result.verdict, 'skipped'); assert.equal(result.reason, 'no-free-chapter');
});
