import type { Env } from './types';
import type { CheckOptions, CheckOutcome } from './handlers/availability-check';
import { resolveReaderConfig } from './reader-content';

export async function sourceCheckOptions(env: Env, depth: 'search' | 'content' = 'search'): Promise<CheckOptions> {
  const reader = await resolveReaderConfig(env, 'check');
  return { depth, reader: reader ? { url: reader.readerUrl, accessToken: reader.accessToken } : undefined };
}

export type SourceCheckRecord = CheckOutcome & { id: number; duration?: number; version?: unknown };

/** 检测结果单独保存，待确认不会伪装成正常或覆盖上次可用性；登录源直接禁用。 */
export async function persistSourceChecks(env: Env, records: SourceCheckRecord[]) {
  const counts = { available: 0, unavailable: 0, skipped: 0 };
  const statements = [];
  for (const row of records) {
    counts[row.verdict]++;
    const login = row.reason === 'login-required' || row.reason === 'login-redirect';
    statements.push(env.DB.prepare(`
      INSERT INTO source_checks (source_id, source_updated_at, verdict, reason, detail, duration, checked_at)
      SELECT id, updated_at, ?, ?, ?, ?, datetime('now') FROM sources WHERE id = ? AND updated_at = COALESCE(?, updated_at)
      ON CONFLICT(source_id) DO UPDATE SET source_updated_at=excluded.source_updated_at, verdict=excluded.verdict, reason=excluded.reason,
        detail=excluded.detail, duration=excluded.duration, checked_at=excluded.checked_at
      RETURNING source_id
    `).bind(row.verdict, row.reason, (row.detail || '').slice(0, 300), Math.max(0, Math.round(row.duration || 0)), row.id, row.version ?? null));
    statements.push(env.DB.prepare(`
      UPDATE sources SET last_checked = datetime('now'),
        is_available = CASE WHEN ? = 'available' THEN 1 WHEN ? = 'unavailable' THEN 0 ELSE is_available END,
        enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
        group_name = CASE WHEN ? = 0 THEN group_name WHEN group_name LIKE '%需登录%' THEN group_name
          WHEN group_name IS NULL OR group_name = '' THEN '需登录' ELSE group_name || ',需登录' END
      WHERE id = ? AND updated_at = COALESCE(?, updated_at)
    `).bind(row.verdict, row.verdict, login ? 1 : 0, login ? 1 : 0, row.id, row.version ?? null));
  }
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return counts;
}
