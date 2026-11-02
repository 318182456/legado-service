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

