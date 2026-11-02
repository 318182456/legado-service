import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { handleSubscribeThemes } from '../worker/handlers/subscribe';
import type { Env } from '../worker/types';

test('subscription catalogue exposes only import card fields, never theme configuration', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE custom_themes (id INTEGER, name TEXT, preview_url TEXT, config TEXT, created_at INTEGER)');
    db.prepare('INSERT INTO custom_themes VALUES (?,?,?,?,?)').run(1, 'first', '/repo/preview/a.png', '{"private":"hidden"}', 1);
    db.prepare('INSERT INTO custom_themes VALUES (?,?,?,?,?)').run(2, '<img onerror=alert(1)>', null, '{"secret":"hidden"}', 2);
    const env = { DB: { prepare: (sql: string) => ({ all: async () => ({ results: db.prepare(sql).all() }) }) } } as unknown as Env;
    const response = await handleSubscribeThemes(env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.data.map((r: any) => r.id), [2, 1]);
    assert.deepEqual(Object.keys(body.data[0]).sort(), ['id', 'name', 'preview_url']);
    assert.equal(JSON.stringify(body).includes('hidden'), false);
  } finally { db.close(); }
});

test('empty subscription catalogue succeeds with an empty collection', async () => {
  const env = { DB: { prepare: () => ({ all: async () => ({ results: [] }) }) } } as unknown as Env;
  assert.deepEqual(await (await handleSubscribeThemes(env)).json(), { ok: true, data: [] });
});


test('subscription preview accepts canvas raster thumbnails and same-origin resources only', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const html = readFileSync(new URL('../worker/handlers/subscribe.html', import.meta.url), 'utf8');
  const start = html.indexOf('        function themePreviewUrl(');
  const end = html.indexOf('        let resourcesLoading', start);
  assert.ok(start > 0 && end > start);
  const context = { URL, resolve: null as any };
  runInNewContext(html.slice(start, end) + ';resolve = themePreviewUrl;', context);
  const origin = 'https://reader.example.test:8443';
  for (const type of ['webp', 'png', 'jpeg', 'gif']) {
    const src = 'data:image/' + type + ';base64,AAAA';
    assert.equal(context.resolve(src, origin), src);
  }
  assert.equal(context.resolve('/repo/previews/a.png', origin), origin + '/repo/previews/a.png');
  for (const src of [null, '', 'data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA',
    'javascript:alert(1)', 'data:image/webp;base64,AA" onerror="alert(1)',
    'https://outside.example.test/repo/a.png', '/api/system/config',
    'https://u:p@reader.example.test:8443/repo/a.png']) {
    assert.equal(context.resolve(src, origin), null);
  }
});
