import type { Env } from './types';

export function positiveInteger(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null || !value.trim()) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** SQL 片段仅来自调用方常量；查询值通过 bind 传入。先计数才能校正删除后的页码。 */
export async function readPage(env: Env, options: {
  table: 'sources' | 'rules' | 'txt_toc_rules' | 'dict_rules';
  where: string;
  params: unknown[];
  orderBy: string;
  page: number;
  limit: number;
}) {
  const { table, where, params, orderBy, limit } = options;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).bind(...params).first();
  const total = Number(row?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(options.page, totalPages);
  const offset = (page - 1) * limit;
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset).all();
  return { results, total, totalPages, page, limit, hasMore: offset + results.length < total };
}
