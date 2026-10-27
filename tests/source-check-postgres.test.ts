import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { PostgresD1 } from '../adapter/postgres';
import { persistSourceChecks } from '../worker/source-check';
import type { Env } from '../worker/types';

test('Postgres 适配器批量保存检测结果时使用 source_id，避免自动追加不存在的 id 中断事务', async t => {
  const queries: string[] = [];
  t.mock.method(pg.Pool.prototype, 'connect', async () => ({
    query: async (sql: string) => {
      queries.push(sql);
      if (/INSERT INTO source_checks/.test(sql)) {
        assert.match(sql, /RETURNING source_id/);
        assert.doesNotMatch(sql, /RETURNING id\b/);
      }
      return { rows: [], rowCount: 1 };
    },
    release() {},
  }));
  const DB = new PostgresD1('postgres://unused.invalid/test');
  t.after(() => (DB as any).pool.end());
  await persistSourceChecks({ DB } as Env, [{ id: 1, verdict: 'unavailable', reason: 'login-required' }]);
  assert.equal(queries[0], 'BEGIN');
  assert.equal(queries.at(-1), 'COMMIT');
  assert.ok(queries.some(sql => /UPDATE sources/.test(sql)));
});
