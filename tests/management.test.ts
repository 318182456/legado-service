import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { SCHEMA_STATEMENTS } from '../worker/schema-statements';
import { persistSourceChecks } from '../worker/source-check';
import { positiveInteger } from '../worker/pagination';
import { handleListSources, handleTestAllSources, handleStopTestSources, handleCleanupSources } from '../worker/handlers/sources';
import { handleListRules } from '../worker/handlers/rules';
import { handleListTxtTocRules } from '../worker/handlers/txt-toc-rules';
import { handleListDictRules } from '../worker/handlers/dict-rules';
import { handleSync } from '../worker/handlers/subscriptions';
import type { Env } from '../worker/types';

/** 真实内存 SQL、项目表结构和处理器；不连接用户数据库。 */
function fixture(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  for (const sql of SCHEMA_STATEMENTS) if (/^CREATE /i.test(sql.trim())) db.exec(sql);
  t.after(() => db.close());
  db.exec("INSERT INTO subscriptions (name,url,type) VALUES ('测试分组','manual_sources','source')");
  const kv = new Map<string, string>();
  const prepare = (sql: string) => {
    let args: any[] = [];
    const statement = {
      bind(...values: any[]) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return statement;
  };
  const env = {
    DB: { prepare, batch: async (stmts: any[]) => Promise.all(stmts.map(s => s.run())) },
    KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value); } },
  } as unknown as Env;
  const addSource = (id: number, raw = '{}') => db.prepare('INSERT INTO sources (id,subscription_id,name,book_source_url,url_hash,raw_json) VALUES (?,1,?,?,?,?)')
    .run(id, `书源${id}`, `https://source.invalid/${id}`, String(id), raw);
  return { db, kv, env, addSource };
}
const body = async (response: Response) => (await response.json() as any).data;

test('分页拒绝 NaN、无限值、小数及负数，限制单页最大数量', () => {
  for (const value of ['NaN', 'Infinity', '1.5', '-2', '0', '']) assert.equal(positiveInteger(value, 10, 100), 10);
  assert.equal(positiveInteger('100000', 10, 100), 100);
});

test('四种列表删除末页最后一条后回到有效页，空列表仍显示第 1 页', async t => {
  const { db, env, addSource } = fixture(t);
  for (let i = 1; i <= 11; i++) {
    addSource(i);
    db.prepare("INSERT INTO rules (id,subscription_id,name,pattern_hash,raw_json) VALUES (?,1,?,?,'{}')").run(i, `规则${i}`, String(i));
    db.prepare("INSERT INTO txt_toc_rules (id,subscription_id,name,rule_hash,raw_json) VALUES (?,1,?,?,'{}')").run(i, `目录${i}`, String(i));
    db.prepare("INSERT INTO dict_rules (id,subscription_id,name,raw_json) VALUES (?,1,?,'{}')").run(i, `字典${i}`);
  }
  const handlers = [handleListSources, handleListRules, handleListTxtTocRules, handleListDictRules];
  const tables = ['sources', 'rules', 'txt_toc_rules', 'dict_rules'];
  for (let i = 0; i < handlers.length; i++) {
    const url = new URL('http://local/list?page=2');
    const before = await body(await handlers[i](env, url));
    assert.equal(before.total, 11);
    assert.equal(before.page, 2);
    assert.equal((before.sources ?? before.rules)[0].id, 1);
    db.exec(`DELETE FROM ${tables[i]} WHERE id=1`);
    const after = await body(await handlers[i](env, url));
    assert.equal(after.total, 10);
    assert.equal(after.page, 1);
    assert.equal(after.totalPages, 1);
    assert.equal((after.sources ?? after.rules).length, 10);
    db.exec(`DELETE FROM ${tables[i]}`);
    const empty = await body(await handlers[i](env, url));
    assert.equal(empty.total, 0);
    assert.equal(empty.page, 1);
    assert.equal(empty.totalPages, 1);
  }
});

test('书源搜索及筛选保留完整参数，并对异常页码使用默认值', async t => {
  const { db, env, addSource } = fixture(t);
  addSource(1);
  addSource(2);
  db.exec("UPDATE sources SET name='A&B#中文', is_available=0 WHERE id=1");
  await persistSourceChecks(env, [{ id: 1, verdict: 'unavailable', reason: 'http-error', detail: '源站错误' }]);
  const url = new URL('http://local/list');
  url.search = new URLSearchParams({ q: 'A&B#中文', filter: 'unavailable', page: 'NaN', limit: 'Infinity' }).toString();
  const result = await body(await handleListSources(env, url));
  assert.equal(result.total, 1);
  assert.equal(result.sources[0].id, 1);
  assert.equal(result.page, 1);
  assert.equal(result.limit, 10);
});

test('登录源直接禁用；待确认保留原状态，自动清理只处理本版本确认失效的源', async t => {
  const { db, env, addSource } = fixture(t);
  addSource(1); addSource(2); addSource(3);
  db.exec("UPDATE sources SET is_available=0 WHERE id=2");
  await persistSourceChecks(env, [
    { id: 1, verdict: 'unavailable', reason: 'login-required' },
    { id: 2, verdict: 'skipped', reason: 'anti-bot' },
    { id: 3, verdict: 'unavailable', reason: 'http-error' },
  ]);
  const login = await env.DB.prepare('SELECT * FROM sources WHERE id=1').first();
  assert.equal(login.enabled, 0);
  assert.match(login.group_name, /需登录/);
  await handleCleanupSources(env);
  assert.equal((await env.DB.prepare('SELECT enabled FROM sources WHERE id=2').first()).enabled, 1);
  assert.equal((await env.DB.prepare('SELECT enabled FROM sources WHERE id=3').first()).enabled, 0);
  const pending = await body(await handleListSources(env, new URL('http://local/list?filter=skipped')));
  assert.equal(pending.sources.length, 1);
  assert.equal(pending.sources[0].check_reason, 'anti-bot');
});

test('书源更新后旧检测结果作废，迟到的旧版本结果不能禁用新配置', async t => {
  const { db, env, addSource } = fixture(t);
  addSource(1);
  db.exec("UPDATE sources SET updated_at='2026-01-01' WHERE id=1");
  await persistSourceChecks(env, [{ id: 1, version: '2026-01-01', verdict: 'available', reason: 'content-verified' }]);
  db.exec("UPDATE sources SET updated_at='2026-02-01', raw_json='{\"changed\":true}' WHERE id=1");
  await persistSourceChecks(env, [{ id: 1, version: '2026-01-01', verdict: 'unavailable', reason: 'login-required' }]);
  const result = await body(await handleListSources(env, new URL('http://local/list?filter=unchecked')));
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].check_verdict, undefined);
  assert.equal(result.sources[0].enabled, 1);
  await handleCleanupSources(env);
  assert.equal((await env.DB.prepare('SELECT enabled FROM sources WHERE id=1').first()).enabled, 1);
});

test('已有全库测试时拒绝重复启动，停止时保留进度并明确标记 stopped', async t => {
  const { env, kv } = fixture(t);
  kv.set('test_progress', JSON.stringify({ current: 7, total: 10, running: true, runId: 'existing' }));
  assert.equal((await handleTestAllSources(env, {})).status, 409);
  await handleStopTestSources(env);
  assert.deepEqual(JSON.parse(kv.get('test_progress')!), { current: 7, total: 10, running: false, runId: 'existing', status: 'stopped' });
});

test('后台测试完成保存结果和 completed 状态，写入失败则报告 failed', async t => {
  const { env, kv, addSource } = fixture(t);
  addSource(1, 'invalid-json'); // 本地解析失败，不请求任何书源网站。
  let work: Promise<void>;
  const ctx = { waitUntil: (p: Promise<void>) => { work = p; } };
  await handleTestAllSources(env, ctx);
  await work!;
  assert.equal(JSON.parse(kv.get('test_progress')!).status, 'completed');
  assert.equal(JSON.parse(kv.get('test_progress')!).current, 1);
  t.mock.method(env.DB, 'batch', async () => { throw new Error('模拟数据库写入失败'); });
  await handleTestAllSources(env, ctx);
  await work!;
  assert.equal(JSON.parse(kv.get('test_progress')!).status, 'failed');
});

test('已停止的旧任务不能清空新任务的进度', async t => {
  const { env, kv, addSource } = fixture(t);
  addSource(1, 'invalid-json');
  let work: Promise<void>;
  await handleTestAllSources(env, { waitUntil: (p: Promise<void>) => { work = p; } });
  await handleStopTestSources(env);
  const next = { current: 3, total: 8, running: true, status: 'running', runId: 'new-run' };
  kv.set('test_progress', JSON.stringify(next));
  await work!;
  assert.deepEqual(JSON.parse(kv.get('test_progress')!), next);
});

test('同步统计真实抓取与入库结果，跳过手动分组，缺失订阅返回 404', async t => {
  const { db, env } = fixture(t);
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ bookSourceUrl: 'https://source.invalid', bookSourceName: '同步测试源' }]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  db.prepare("INSERT INTO subscriptions (name,url,type) VALUES ('正常订阅',?,'source')").run(`http://127.0.0.1:${address.port}/sources`);
  db.exec("INSERT INTO subscriptions (name,url,type) VALUES ('失败订阅','not-a-url','source')");
  const result = await body(await handleSync(env, null));
  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures[0].name, '失败订阅');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) as count FROM sources').first()).count, 1);
  assert.equal((await handleSync(env, 999)).status, 404);
  t.mock.method(env.DB, 'batch', async () => { throw new Error('模拟入库失败'); });
  const failed = await body(await handleSync(env, 2));
  assert.equal(failed.failed, 1);
  assert.equal(failed.succeeded, 0);
  assert.match(failed.failures[0].error, /模拟入库失败/);
});
