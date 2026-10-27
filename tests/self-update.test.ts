import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { handlePerformUpdate } from '../worker/handlers/system';
import { markRuntimeDependencies } from '../runtime-dependencies.mjs';
import type { Env } from '../worker/types';

test('在线更新构建失败会返回失败，不能继续安排重启', async t => {
  const original = process.cwd();
  const root = mkdtempSync(join(tmpdir(), 'legado-update-'));
  t.after(() => {
    process.chdir(original);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const manifest = JSON.stringify({ name: 'update-fixture', scripts: { build: 'node -e "process.exit(17)"' } });
  writeFileSync(join(root, 'package.json'), manifest);
  writeFileSync(join(root, 'package-lock.json'), '{}');
  mkdirSync(join(root, 'node_modules'));
  markRuntimeDependencies(root);
  const archive = zipSync({ 'repo-main/package.json': strToU8(manifest), 'repo-main/package-lock.json': strToU8('{}') });
  t.mock.method(globalThis, 'fetch', async () => new Response(archive));
  let restarts = 0;
  t.mock.method(globalThis, 'setTimeout', () => { restarts++; return 0; });
  const env = { DB: { prepare: () => ({ first: async () => ({ value: '' }) }) } } as unknown as Env;
  process.chdir(root);
  const response = await handlePerformUpdate(env);
  const result = await response.json() as any;
  assert.equal(result.ok, false);
  assert.ok(response.status >= 400);
  assert.equal(restarts, 0);
});
