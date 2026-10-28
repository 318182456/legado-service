import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_STATEMENTS } from '../worker/schema-statements';
import { claimReviewRetries, executeReviewRetries, failReviewAttempt, isRetryableReviewError } from '../worker/review-retry';
import { handleListReviewFailures, handleRetryReviewFailures, retryFailedReviewChapters, handleReviewSummary } from '../worker/handlers/reviews';
import type { Env } from '../worker/types';

function fixture(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const sql of SCHEMA_STATEMENTS) {
    if (/^CREATE /i.test(sql.trim())) db.exec(sql);
    else if (/^ALTER TABLE (review_chapters|reviews) ADD COLUMN/i.test(sql.trim())) {
      try { db.exec(sql); } catch (error) { if (!String(error).includes('duplicate column')) throw error; }
    }
  }
  const prepare = (sql: string) => {
    let args: any[] = [];
    const statement = {
      bind(...values: any[]) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
    };
    return statement;
  };
  const env = { DB: { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map(s => s.run())) }, KV: { get: async () => null, put: async () => {} } } as unknown as Env;
  const config = (key: string, value: string) => db.prepare('INSERT INTO system_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  config('gemini_api_key', 'fixture-key');
  config('gemini_base_url', 'https://model.invalid/v1');
  const chapter = (id = 1, status = 'failed', payload: string | null = JSON.stringify(['门忽然开了，他发现钥匙一直在自己手中。'])) => {
    db.prepare("INSERT INTO review_chapters (id,book_key,chapter_key,book_name,chapter_title,status,error,retry_payload) VALUES (?, 'book', ?, 'fixture', ?, ?, ?, ?)")
      .run(id, `chapter${id}`, `第${id}章`, status, status === 'failed' ? '模型接口 HTTP 503' : null, payload);
  };
  return { db, env, config, chapter };
}
const completion = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ reviews: [{ paraIndex: 1, author: '书友', content: '钥匙原来一直在手里，刚才白紧张了' }] }) } }] });
const retryRequest = (body: any) => new Request('http://local/api/reviews/retry', { method: 'POST', body: JSON.stringify(body) });
const failures = async (env: Env) => (await (await handleListReviewFailures(env, new URL('http://local/api/reviews/failures'))).json() as any).data;

test('自动重试使用 1/5/15 分钟退避，最多三次；手动仍可重试', async t => {
  const f = fixture(t); f.chapter(1, 'pending');
  const start = Date.now();
  let now = start;
  await failReviewAttempt(f.env, 'book', 'chapter1', new Error('模型接口 HTTP 503'), undefined, ['正文'], now);
  for (const delay of [60_000, 300_000, 900_000]) {
    const row = f.db.prepare('SELECT * FROM review_chapters WHERE id=1').get()!;
    assert.equal(Date.parse(row.retry_after as string) - now, delay);
    assert.equal((await claimReviewRetries(f.env, { now: now + delay - 1 })).claims.length, 0);
    now += delay;
    const { claims } = await claimReviewRetries(f.env, { now });
    assert.equal(claims.length, 1);
    await failReviewAttempt(f.env, 'book', 'chapter1', '模型接口 HTTP 503', claims[0].attempt_id, ['正文'], now);
  }
  assert.equal((await claimReviewRetries(f.env, { now: now + 3600000 })).claims.length, 0);
  assert.equal((await claimReviewRetries(f.env, { manual: true, now: now + 3600000 })).claims.length, 1);
});

test('配置和鉴权错误不自动重试，临时错误可重试，关闭开关不运行模型', async t => {
  for (const message of ['模型接口 HTTP 401', '模型接口 HTTP 403', '未配置模型 API Key', '订阅库里找不到书源']) assert.equal(isRetryableReviewError(message), false);
  for (const message of ['模型接口 HTTP 429', '模型接口 HTTP 503', '请求超时', 'fetch failed']) assert.equal(isRetryableReviewError(message), true);
  const f = fixture(t); f.chapter(); f.config('review_auto_retry', '0');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not call model'); });
  await retryFailedReviewChapters(f.env);
  assert.equal(f.db.prepare('SELECT status FROM review_chapters').get()!.status, 'failed');
});

test('并发手动/自动抢占同一章节仅成功一次，旧尝试不能覆盖新尝试', async t => {
  const f = fixture(t); f.chapter();
  const [automatic, manual] = await Promise.all([claimReviewRetries(f.env), claimReviewRetries(f.env, { manual: true })]);
  assert.equal(automatic.claims.length + manual.claims.length, 1);
  const row = f.db.prepare('SELECT * FROM review_chapters').get()!;
  await failReviewAttempt(f.env, 'book', 'chapter1', 'stale', 'wrong-attempt');
  assert.equal(f.db.prepare('SELECT status FROM review_chapters').get()!.status, 'generating');
  assert.equal(f.db.prepare('SELECT attempt_id FROM review_chapters').get()!.attempt_id, row.attempt_id);
});

test('失败原因在重试期间保留，成功后自动移除失败记录并保留成功评论和人工批注', async t => {
  const f = fixture(t); f.chapter(); f.chapter(2, 'done');
  f.db.exec("INSERT INTO reviews (book_key,chapter_key,author,content,origin) VALUES ('book','chapter1','人','人工批注','human'),('book','chapter1','旧AI','上次部分结果','ai'),('book','chapter2','AI','成功章节','ai')");
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { await gate; return completion(); });
  const jobs: Promise<void>[] = [];
  const response = await handleRetryReviewFailures(retryRequest({ bookKey: 'book', chapterKey: 'chapter1' }), f.env, { waitUntil: (work: Promise<void>) => jobs.push(work) });
  assert.equal((await response.json() as any).data.queued, 1);
  assert.equal((await failures(f.env)).total, 1);
  assert.match(f.db.prepare('SELECT error FROM review_chapters WHERE id=1').get()!.error as string, /503/);
  finish(); await Promise.all(jobs);
  const row = f.db.prepare('SELECT * FROM review_chapters WHERE id=1').get()!;
  assert.equal(row.status, 'done'); assert.equal(row.error, null); assert.equal(row.retry_after, null); assert.equal(row.retry_payload, null); assert.equal(row.retry_count, 0);
  assert.equal((await failures(f.env)).total, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM reviews WHERE content='人工批注'").get()!.n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM reviews WHERE content='成功章节'").get()!.n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM reviews WHERE content='上次部分结果'").get()!.n, 0);
});

test('失败重试仍失败时保留错误并安排下一次，而不是把失败数清零', async t => {
  const f = fixture(t); f.chapter();
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await retryFailedReviewChapters(f.env);
  const row = f.db.prepare('SELECT * FROM review_chapters').get()!;
  assert.equal(row.status, 'failed'); assert.equal(row.retry_count, 1); assert.ok(row.retry_after); assert.match(row.error as string, /503/);
  assert.equal((await failures(f.env)).total, 1);
});

test('缺正文的历史失败转为等 App 提供正文，但成功前仍保留失败记录', async t => {
  const f = fixture(t); f.chapter(1, 'failed', null);
  const response = await handleRetryReviewFailures(retryRequest({ bookKey: 'book' }), f.env, null);
  const result = (await response.json() as any).data;
  assert.equal(result.queued, 0); assert.equal(result.waitingForContent, 1);
  assert.equal(f.db.prepare('SELECT status FROM review_chapters').get()!.status, 'pending');
  assert.equal((await failures(f.env)).total, 1);
});

test('旧生成任务中断后可恢复，批量重试最多十章且跳过成功章节', async t => {
  const f = fixture(t);
  for (let id = 1; id <= 15; id++) f.chapter(id);
  f.chapter(16, 'done');
  f.db.prepare("UPDATE review_chapters SET status='generating', retry_claimed_at=?, attempt_id='old' WHERE id=1").run(new Date(Date.now() - 1200000).toISOString());
  const result = await claimReviewRetries(f.env);
  assert.equal(result.claims.length, 10);
  assert.ok(result.claims.some(row => row.id === 1));
  assert.ok(result.claims.every(row => row.id !== 16));
});

test('未选范围和未配置模型时不改变失败记录', async t => {
  const f = fixture(t); f.chapter();
  assert.equal((await handleRetryReviewFailures(retryRequest({}), f.env, null)).status, 400);
  f.config('gemini_api_key', '');
  assert.equal((await handleRetryReviewFailures(retryRequest({ all: true }), f.env, null)).status, 400);
  assert.equal(f.db.prepare('SELECT status FROM review_chapters').get()!.status, 'failed');
});

test('初次 JS 正文生成失败会保存正文供后台自动重试，成功后不再重试', async t => {
  const f = fixture(t);
  let success = false; let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return success ? completion() : new Response('', { status: 503 }); });
  await handleReviewSummary(new Request('http://local/review/summary', { method: 'POST', body: JSON.stringify({ book: { name: 'fixture' }, chapter: { title: '第一章' }, paragraphs: ['他打开门，钥匙仍然握在手里。'] }) }), f.env);
  const failed = f.db.prepare('SELECT * FROM review_chapters').get()!;
  assert.equal(failed.status, 'failed'); assert.ok(failed.retry_payload);
  f.db.exec('UPDATE review_chapters SET retry_after=NULL'); success = true;
  await retryFailedReviewChapters(f.env);
  assert.equal(f.db.prepare('SELECT status FROM review_chapters').get()!.status, 'done');
  const before = calls; await retryFailedReviewChapters(f.env); assert.equal(calls, before);
});

test('没有缓存正文时可通过 reader 重新取目录和正文后完成重试', async t => {
  const f = fixture(t); f.chapter(1, 'failed', null);
  f.config('reader_url', 'http://reader.invalid');
  f.db.exec("INSERT INTO subscriptions (id,name,url,type) VALUES (1,'fixture','manual_sources','source')");
  f.db.prepare("INSERT INTO sources (subscription_id,book_source_url,name,url_hash,raw_json) VALUES (1,?,'fixture','1','{}')").run('https://books.invalid');
  f.db.exec("UPDATE review_chapters SET book_url='https://books.invalid/book', origin_url='https://books.invalid'");
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('/getChapterList')) return Response.json({ isSuccess: true, data: [{ title: '第1章', url: '/chapter1' }] });
    if (String(url).includes('/getBookContent')) return Response.json({ isSuccess: true, data: '第1章\n他打开门，发现钥匙一直握在自己手里。' });
    return completion();
  });
  await retryFailedReviewChapters(f.env);
  assert.equal(f.db.prepare('SELECT status FROM review_chapters').get()!.status, 'done');
  assert.ok(calls.some(url => url.includes('/getBookContent')));
  assert.equal((await failures(f.env)).total, 0);
});

test('多批重试串行执行，防止失败章节集中冲击 reader 和模型', async t => {
  const f = fixture(t); f.chapter(); f.chapter(2);
  const { claims } = await claimReviewRetries(f.env);
  let running = 0; let maximum = 0;
  const execute = async () => {
    running++; maximum = Math.max(maximum, running);
    await new Promise(resolve => setTimeout(resolve, 10)); running--;
  };
  await Promise.all([executeReviewRetries(f.env, [claims[0]], execute), executeReviewRetries(f.env, [claims[1]], execute)]);
  assert.equal(maximum, 1);
});

test('同章普通请求并发时也只生成一次', async t => {
  const f = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return completion(); });
  const request = () => new Request('http://local/review/summary', { method: 'POST', body: JSON.stringify({ book: { name: 'fixture' }, chapter: { title: '第一章' }, paragraphs: ['他打开门，钥匙仍然握在手里。'] }) });
  await Promise.all([handleReviewSummary(request(), f.env), handleReviewSummary(request(), f.env)]);
  assert.equal(calls, 1);
  assert.equal(f.db.prepare('SELECT status FROM review_chapters').get()!.status, 'done');
});
