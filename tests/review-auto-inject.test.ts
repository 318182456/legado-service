import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_STATEMENTS } from '../worker/schema-statements';
import { rebuildCache } from '../worker/utils';
import { handleSubscribeOutput } from '../worker/handlers/subscribe';
import { handleInjectReviewRule, handleCheckSourceStatus } from '../worker/handlers/reviews';
import { buildReviewRule } from '../worker/review-rule';
import type { Env } from '../worker/types';

function fixture(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const sql of SCHEMA_STATEMENTS) if (/^CREATE /i.test(sql.trim())) db.exec(sql);
  db.exec("INSERT INTO subscriptions (id,name,url,type) VALUES (1,'fixture','manual_sources','source')");
  const cache = new Map<string, string>();
  const prepare = (sql: string) => {
    let args: any[] = [];
    const statement = {
      bind(...values: any[]) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    };
    return statement;
  };
  const env = {
    DB: { prepare, batch: async (statements: any[]) => Promise.all(statements.map(s => s.run())) },
    KV: { get: async (key: string) => cache.get(key) ?? null, put: async (key: string, value: string) => { cache.set(key, value); } },
  } as unknown as Env;
  const add = (id: number, source: any = { bookSourceName: `书源${id}`, bookSourceUrl: `https://books.invalid/${id}` }) =>
    db.prepare("INSERT INTO sources (id,subscription_id,name,book_source_url,url_hash,raw_json,updated_at) VALUES (?,1,?,?,?,?,'2026-01-01')")
      .run(id, source.bookSourceName ?? '', source.bookSourceUrl ?? `https://books.invalid/${id}`, String(id), JSON.stringify(source));
  const config = (key: string, value: string) => db.prepare('INSERT INTO system_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  const request = (origin = 'https://public.invalid') => new Request(origin + '/subscribe/sources');
  const output = async (req = request()) => (await (await handleSubscribeOutput(env, 'sources', req)).json()) as any[];
  return { db, cache, env, add, config, request, output };
}

test('订阅 MISS/HIT 默认自动接入，后续新增或同步后的书源也无需手动注入', async t => {
  const f = fixture(t);
  f.add(1);
  const first = await handleSubscribeOutput(f.env, 'sources', f.request());
  assert.equal(first.headers.get('X-Cache'), 'MISS');
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.match((await first.json() as any[])[0].ruleReview.reviewSummaryUrl, /^https:\/\/public.invalid\/review\/summary/);
  const raw = f.cache.get('sources')!;
  assert.equal(JSON.parse(raw)[0].ruleReview, undefined);
  const hit = await handleSubscribeOutput(f.env, 'sources', f.request());
  assert.equal(hit.headers.get('X-Cache'), 'HIT');
  assert.equal((await hit.json() as any[])[0].bookSourceName, '💬书源1');
  f.add(2);
  await rebuildCache(f.env, 'source');
  assert.equal((await f.output()).filter(s => s.ruleReview?.enabled).length, 2);
  assert.deepEqual(f.db.prepare('SELECT updated_at FROM sources').all().map(r => r.updated_at), ['2026-01-01', '2026-01-01']);
});

test('缓存命中时令牌、域名和反代 HTTPS 同步更新，不污染原始缓存或书源', async t => {
  const f = fixture(t);
  f.add(1);
  f.config('review_token', 'first token');
  const first = (await f.output())[0].ruleReview;
  assert.match(first.reviewSummaryUrl, /token=first%20token/);
  const raw = f.cache.get('sources');
  f.config('review_token', 'next-token');
  const forwarded = new Request('http://container:8080/subscribe/sources', { headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'books.invalid:8443, proxy' } });
  const next = (await f.output(forwarded))[0].ruleReview;
  assert.match(next.reviewSummaryUrl, /^https:\/\/books.invalid:8443\//);
  assert.match(next.reviewSummaryUrl, /token=next-token/);
  assert.doesNotMatch(next.reviewSummaryUrl, /first%20token/);
  assert.equal(f.cache.get('sources'), raw);
  assert.equal(JSON.parse(f.db.prepare('SELECT raw_json FROM sources').get()!.raw_json as string).ruleReview, undefined);
});

test('JS 书源和已有其他段评规则原样保留，包括相似的 summary URL', async t => {
  const f = fixture(t);
  const sources = [
    { bookSourceName: 'JS', mainJs: 'const source = {};' },
    { bookSourceName: '其他规则', ruleReview: { reviewSummaryUrl: 'https://other.invalid/review/summary', enabled: true } },
    { bookSourceName: '字符串规则', ruleReview: '{"enabled":true}' },
    { bookSourceName: '关闭的其他规则', ruleReview: { enabled: false } },
  ];
  sources.forEach((source, i) => f.add(i + 1, source));
  const output = await f.output();
  output.forEach((source, i) => { const { bookSourceGroup, ...rest } = source; assert.deepEqual(rest, sources[i]); });
});

test('历史注入规则自动刷新且标记不叠加，保留书源原来的 emoji', async t => {
  const f = fixture(t);
  f.add(1, { bookSourceName: '💬旧书源', ruleReview: buildReviewRule('https://old.invalid', 'old') });
  f.add(2, { bookSourceName: '⭐原有图标' });
  const sources = await f.output();
  assert.equal(sources[0].bookSourceName, '💬旧书源');
  assert.equal(sources[1].bookSourceName, '💬⭐原有图标');
  assert.match(sources[0].ruleReview.reviewSummaryUrl, /^https:\/\/public.invalid/);
  assert.deepEqual(await f.output(), sources);
  f.config('review_auto_mark_name', '0');
  assert.equal((await f.output())[1].bookSourceName, '⭐原有图标');
});

test('关闭自动接入会剥离本服务的历史注入，其他规则不动', async t => {
  const f = fixture(t);
  f.config('review_auto_inject', '0');
  f.add(1, { bookSourceName: '💬旧书源', ruleReview: buildReviewRule('https://old.invalid', 'old') });
  f.add(2);
  const output = await f.output();
  assert.deepEqual(output[0].ruleReview, {});
  assert.equal(output[0].bookSourceName, '旧书源');
  assert.equal(output[1].ruleReview, undefined);
});

test('全局撤销同时关闭自动接入，下一次订阅不会重新注入', async t => {
  const f = fixture(t);
  f.add(1, { bookSourceName: '💬旧书源', ruleReview: buildReviewRule('https://old.invalid', 'old') });
  f.add(2);
  const response = await handleInjectReviewRule(new Request('https://public.invalid/api/reviews/inject', { method: 'POST', body: JSON.stringify({ revoke: true }) }), f.env);
  assert.equal((await response.json() as any).data.changed, 1);
  assert.equal(f.db.prepare("SELECT value FROM system_config WHERE key='review_auto_inject'").get()!.value, '0');
  assert.ok((await f.output()).every(source => !source.ruleReview?.enabled));
});

test('书源诊断使用自动下发的有效规则，不会误报未注入', async t => {
  const f = fixture(t);
  f.add(1);
  const req = new Request('https://public.invalid/api/reviews/source-status?q=书源');
  const response = await handleCheckSourceStatus(req, f.env, new URL(req.url));
  const match = (await response.json() as any).data.matches[0];
  assert.equal(match.usable, true);
  assert.equal(match.hasReviewRule, true);
});
