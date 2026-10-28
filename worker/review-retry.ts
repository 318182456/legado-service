import type { Env } from "./types";

export const AUTO_RETRY_LIMIT = 3;
const DELAYS = [60_000, 5 * 60_000, 15 * 60_000];
export interface RetryChapter {
  id: number; book_key: string; chapter_key: string; book_name: string; author: string;
  chapter_title: string; book_url?: string; origin_url?: string; retry_payload?: string;
  retry_count: number; attempt_id: string; error?: string;
}
export const isRetryableReviewError = (error: string): boolean =>
  !/HTTP (400|401|403|404)|API.?Key|鉴权|认证|未配置|找不到书源|目录.*找不到|未找到.*章|输出被截断|未知的模型接口/i.test(error);

export async function autoReviewRetryEnabled(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'review_auto_retry'").first() as any;
  return row?.value !== '0' && row?.value !== 'false';
}

export function retryParagraphs(row: { retry_payload?: string | null }): string[] {
  try {
    const value = JSON.parse(row.retry_payload || 'null');
    return Array.isArray(value) ? value.filter(p => typeof p === 'string' && p.trim()) : [];
  } catch { return []; }
}

export async function failReviewAttempt(env: Env, bookKey: string, chapterKey: string, error: unknown, attemptId?: string, paragraphs?: string[], now = Date.now()): Promise<void> {
  const message = String(error instanceof Error ? error.message : error || '生成失败').slice(0, 500);
  const row = await env.DB.prepare('SELECT retry_count FROM review_chapters WHERE book_key = ? AND chapter_key = ?').bind(bookKey, chapterKey).first() as any;
  const retries = Number(row?.retry_count || 0);
  const next = isRetryableReviewError(message) && retries < AUTO_RETRY_LIMIT ? new Date(now + DELAYS[retries]).toISOString() : null;
  const payload = paragraphs?.length ? JSON.stringify(paragraphs) : null;
  await env.DB.prepare(`UPDATE review_chapters SET status='failed', error=?, retry_after=?, auto_retryable=?,
    retry_payload=COALESCE(?, retry_payload), retry_claimed_at=NULL
    WHERE book_key=? AND chapter_key=? ${attemptId ? 'AND attempt_id=?' : "AND status='pending'"}`)
    .bind(message, next, isRetryableReviewError(message) ? 1 : 0, payload && payload.length <= 2_000_000 ? payload : null, bookKey, chapterKey, ...(attemptId ? [attemptId] : [])).run();
}

/** Retain failure text while queued/running; only a successful attempt clears it. */
export async function claimReviewRetries(env: Env, opts: { manual?: boolean; bookKey?: string; chapterKey?: string; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const stamp = new Date(now).toISOString();
  await env.DB.prepare(`UPDATE review_chapters SET status='failed', error=COALESCE(error, '生成任务中断，等待重试'),
    retry_after=?, attempt_id=NULL, retry_claimed_at=NULL
    WHERE status='generating' AND (retry_claimed_at < ? OR (retry_claimed_at IS NULL AND created_at < ?))`)
    .bind(stamp, new Date(now - 10 * 60_000).toISOString(), new Date(now - 10 * 60_000).toISOString()).run();
  const args: any[] = [];
  let where = "status='failed'";
  if (opts.bookKey) { where += ' AND book_key=?'; args.push(opts.bookKey); }
  if (opts.chapterKey) { where += ' AND chapter_key=?'; args.push(opts.chapterKey); }
  if (!opts.manual) { where += ' AND auto_retryable=1 AND retry_count < ? AND (retry_after IS NULL OR retry_after <= ?)'; args.push(AUTO_RETRY_LIMIT, stamp); }
  const rows = await env.DB.prepare(`SELECT * FROM review_chapters WHERE ${where} ORDER BY id LIMIT 10`).bind(...args).all();
  const claims: RetryChapter[] = [];
  let waitingForContent = 0;
  for (const row of rows.results as any[]) {
    if (!opts.manual && !isRetryableReviewError(row.error || '')) {
      await env.DB.prepare("UPDATE review_chapters SET auto_retryable=0 WHERE id=? AND status='failed'").bind(row.id).run();
      continue;
    }
    if (!retryParagraphs(row).length && !(row.book_url && row.origin_url)) {
      if (opts.manual) {
        const result = await env.DB.prepare("UPDATE review_chapters SET status='pending', retry_after=NULL, retry_count=0 WHERE id=? AND status='failed'").bind(row.id).run();
        waitingForContent += Number(result.meta?.changes || 0);
      }
      if (!opts.manual) await env.DB.prepare("UPDATE review_chapters SET auto_retryable=0 WHERE id=? AND status='failed'").bind(row.id).run();
      continue;
    }
    const attempt = crypto.randomUUID();
    const result = await env.DB.prepare(`UPDATE review_chapters SET status='generating', attempt_id=?, retry_claimed_at=?, retry_after=NULL,
      retry_count=${opts.manual ? '0' : 'retry_count'}+1 WHERE id=? AND status='failed' AND retry_count=? AND COALESCE(attempt_id,'')=?`)
      .bind(attempt, stamp, row.id, Number(row.retry_count || 0), row.attempt_id || '').run();
    if (Number(result.meta?.changes || 0) > 0) claims.push({ ...row, attempt_id: attempt });
  }
  return { claims, waitingForContent };
}

const tails = new WeakMap<object, Promise<void>>();
export function executeReviewRetries(env: Env, rows: RetryChapter[], execute: (row: RetryChapter) => Promise<void>): Promise<void> {
  const next = (tails.get(env) || Promise.resolve()).then(async () => {
    for (const row of rows) {
      try {
        const owned = await env.DB.prepare("UPDATE review_chapters SET retry_claimed_at=? WHERE id=? AND status='generating' AND attempt_id=?")
          .bind(new Date().toISOString(), row.id, row.attempt_id).run();
        if (Number(owned.meta?.changes || 0) > 0) await execute(row);
      }
      catch (error) { await failReviewAttempt(env, row.book_key, row.chapter_key, error, row.attempt_id); }
    }
  });
  tails.set(env, next.catch(error => { console.error('[段评重试] 队列失败', (error as Error).message); }));
  return next;
}
