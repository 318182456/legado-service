/**
 * 段评接口
 *
 * 公开的三个 /review/* 由 Legado JS 书源调用，与书源函数一一对应：
 *   POST /review/summary  → getReviewSummary
 *   GET  /review/detail   → getReviewDetail
 *   GET  /review/replies  → getReviewReplies
 * /api/reviews/* 为管理端，需鉴权。
 *
 * 定位不用 bookUrl 而用「书名+作者」与「章节标题」的散列，换书源后批注依然命中。
 */

import fs from "fs-extra";
import path from "path";
import { Env } from "../types";
import { ok, err, json, parseBody, hashText, rebuildCache } from "../utils";
import {
  loadAiConfig,
  createGenerator,
  DEFAULT_PERSONAS,
  type ReviewDraft,
} from "../review-ai";

const DETAIL_PAGE_SIZE = 20;
const REPLY_PAGE_SIZE = 20;
/** 单次同步生成的等待上限，超时后本章标记失败，不拖死书源请求 */
const GENERATE_TIMEOUT_MS = 45_000;
/** 内嵌回复的条数上限，超过则改由 getReviewReplies 分页拉取 */
const INLINE_REPLY_LIMIT = 3;

// ─── 访问令牌 ─────────────────────────────────────────────────────

/**
 * /review/* 必须对书源公开，不能用管理端的鉴权。
 * 配了 review_token 就要求请求带上，否则任何知道域名的人都能投喂正文烧掉 API 额度。
 * 未配置时不校验，方便本地调试。
 */
async function reviewTokenGuard(env: Env, url: URL): Promise<Response | null> {
  const row = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_token'`
  ).first()) as any;

  const expected = String(row?.value ?? "").trim();
  if (!expected) return null;

  const provided = (url.searchParams.get("token") ?? "").trim();
  if (provided !== expected) return err("Invalid review token", 401);
  return null;
}

// ─── key 计算 ─────────────────────────────────────────────────────

/** 抹平书源之间的排版差异，让同一本书在不同源下算出同一个 key */
function normalizeKeyText(text: string): string {
  return text
    .replace(/[\s　]+/g, "")
    .replace(/[《》「」『』()（）【】\[\]]/g, "")
    .toLowerCase();
}

async function bookKeyOf(name: string, author: string): Promise<string> {
  return hashText(`${normalizeKeyText(name)}::${normalizeKeyText(author)}`);
}

async function chapterKeyOf(title: string): Promise<string> {
  return hashText(normalizeKeyText(title));
}

async function paraHashOf(text: string): Promise<string> {
  return hashText(normalizeKeyText(text).slice(0, 120));
}

/** summary 把定位信息塞进 paraData，detail 请求时原样回传 */
function packParaData(bookKey: string, chapterKey: string): string {
  return `${bookKey}.${chapterKey}`;
}

function unpackParaData(data: string): { bookKey: string; chapterKey: string } | null {
  const parts = String(data || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { bookKey: parts[0], chapterKey: parts[1] };
}

// ─── 公开：段评统计 ───────────────────────────────────────────────

interface SummaryBody {
  book?: { name?: string; author?: string };
  chapter?: { title?: string };
  paragraphs?: string[];
  /** 传 1 时忽略已有结果重新生成 */
  force?: number | boolean;
}

export async function handleReviewSummary(request: Request, env: Env): Promise<Response> {
  const denied = await reviewTokenGuard(env, new URL(request.url));
  if (denied) return denied;

  const body = await parseBody<SummaryBody>(request);
  const bookName = String(body?.book?.name ?? "").trim();
  const chapterTitle = String(body?.chapter?.title ?? "").trim();
  const author = String(body?.book?.author ?? "").trim();

  if (!bookName || !chapterTitle) return err("缺少书名或章节标题");

  const paragraphs = Array.isArray(body?.paragraphs)
    ? body!.paragraphs!.map((p) => String(p ?? "").trim()).filter(Boolean)
    : [];

  const bookKey = await bookKeyOf(bookName, author);
  const chapterKey = await chapterKeyOf(chapterTitle);
  const paraData = packParaData(bookKey, chapterKey);
  const force = body?.force === 1 || body?.force === true;

  // 是否生成由章节状态决定，不能看「有没有评论」——
  // 否则一章只要先有了人工批注，AI 就永远轮不到生成
  if (paragraphs.length) {
    await generateIfNeeded(env, {
      bookKey,
      chapterKey,
      bookName,
      author,
      chapterTitle,
      paragraphs,
      force,
    });
  }

  return json({ list: await summarize(env, bookKey, chapterKey, paraData) });
}

/**
 * 纯查询版统计，不投喂正文也就不会触发生成。
 * 供拿不到正文段落的普通规则书源使用（reviewSummaryUrl 只能发 GET）。
 */
export async function handleReviewSummaryQuery(env: Env, url: URL): Promise<Response> {
  const denied = await reviewTokenGuard(env, url);
  if (denied) return denied;

  const bookName = (url.searchParams.get("book") ?? "").trim();
  const chapterTitle = (url.searchParams.get("chapter") ?? "").trim();
  const author = (url.searchParams.get("author") ?? "").trim();

  if (!bookName || !chapterTitle) return err("缺少 book 或 chapter 参数");

  const bookKey = await bookKeyOf(bookName, author);
  const chapterKey = await chapterKeyOf(chapterTitle);

  return json({
    list: await summarize(env, bookKey, chapterKey, packParaData(bookKey, chapterKey)),
  });
}

async function summarize(
  env: Env,
  bookKey: string,
  chapterKey: string,
  paraData: string
): Promise<{ paraIndex: number; count: number; paraData: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT para_index, COUNT(*) AS cnt FROM reviews
      WHERE book_key = ? AND chapter_key = ? AND reply_to IS NULL
      GROUP BY para_index ORDER BY para_index`
  )
    .bind(bookKey, chapterKey)
    .all();

  return (rows.results ?? [])
    .map((r: any) => ({
      paraIndex: Number(r.para_index),
      count: Number(r.cnt),
      paraData,
    }))
    .filter((r) => r.count > 0 && (r.paraIndex === -1 || r.paraIndex > 0));
}

// ─── 生成 ─────────────────────────────────────────────────────────

interface GenerateTask {
  bookKey: string;
  chapterKey: string;
  bookName: string;
  author: string;
  chapterTitle: string;
  paragraphs: string[];
  force?: boolean;
}

/**
 * 按需生成本章 AI 段评。
 * 已生成、生成中、或此前失败过的章节都直接跳过，避免重复消耗额度。
 */
async function generateIfNeeded(env: Env, task: GenerateTask): Promise<void> {
  const cfg = await loadAiConfig(env);
  // 没配 key 不算错误：人工批注仍可正常使用
  if (!cfg.apiKey) return;

  const claimed = await claimChapter(env, task);
  if (!claimed) return;

  try {
    const generator = createGenerator(cfg);
    const drafts = await withTimeout(
      generator.generate({
        bookName: task.bookName,
        author: task.author,
        chapterTitle: task.chapterTitle,
        paragraphs: task.paragraphs,
        density: cfg.density,
        personas: cfg.personas,
      }),
      GENERATE_TIMEOUT_MS
    );

    await persistDrafts(env, task, drafts);
    await env.DB.prepare(
      `UPDATE review_chapters SET status = 'done', error = NULL, generated_at = datetime('now'),
              para_count = ? WHERE book_key = ? AND chapter_key = ?`
    )
      .bind(task.paragraphs.length, task.bookKey, task.chapterKey)
      .run();
  } catch (e) {
    const message = (e as Error).message?.slice(0, 500) ?? "生成失败";
    console.error(`段评生成失败 [${task.bookName} - ${task.chapterTitle}]:`, message);
    await env.DB.prepare(
      `UPDATE review_chapters SET status = 'failed', error = ? WHERE book_key = ? AND chapter_key = ?`
    )
      .bind(message, task.bookKey, task.chapterKey)
      .run();
  }
}

/** 抢占本章的生成权，返回 false 表示别处已经处理过或正在处理 */
async function claimChapter(env: Env, task: GenerateTask): Promise<boolean> {
  await env.DB.prepare(
    `INSERT INTO review_chapters (book_key, chapter_key, book_name, author, chapter_title, para_count, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(book_key, chapter_key) DO NOTHING`
  )
    .bind(
      task.bookKey,
      task.chapterKey,
      task.bookName,
      task.author,
      task.chapterTitle,
      task.paragraphs.length
    )
    .run();

  const row = (await env.DB.prepare(
    `SELECT status FROM review_chapters WHERE book_key = ? AND chapter_key = ?`
  )
    .bind(task.bookKey, task.chapterKey)
    .first()) as any;

  const status = row?.status ?? "pending";
  if (!task.force && status !== "pending") return false;

  const res = await env.DB.prepare(
    `UPDATE review_chapters SET status = 'generating', chapter_title = ?, book_name = ?, author = ?
      WHERE book_key = ? AND chapter_key = ? AND status != 'generating'`
  )
    .bind(task.chapterTitle, task.bookName, task.author, task.bookKey, task.chapterKey)
    .run();

  return (res?.meta?.changes ?? 1) > 0;
}

async function persistDrafts(env: Env, task: GenerateTask, drafts: ReviewDraft[]): Promise<void> {
  if (task.force) {
    await env.DB.prepare(
      `DELETE FROM reviews WHERE book_key = ? AND chapter_key = ? AND origin = 'ai'`
    )
      .bind(task.bookKey, task.chapterKey)
      .run();
  }

  for (const draft of drafts) {
    const paraText =
      draft.paraIndex === -1 ? task.chapterTitle : task.paragraphs[draft.paraIndex - 1] ?? "";
    const paraHash = await paraHashOf(paraText);

    const inserted = await env.DB.prepare(
      `INSERT INTO reviews (book_key, chapter_key, para_index, para_hash, author, badge, content, origin)
       VALUES (?, ?, ?, ?, ?, 'AI', ?, 'ai')`
    )
      .bind(
        task.bookKey,
        task.chapterKey,
        draft.paraIndex,
        paraHash,
        draft.author,
        draft.content
      )
      .run();

    const parentId = inserted?.meta?.last_row_id;
    if (!parentId || !draft.replies?.length) continue;

    for (const reply of draft.replies) {
      await env.DB.prepare(
        `INSERT INTO reviews (book_key, chapter_key, para_index, para_hash, author, badge, content, reply_to, origin)
         VALUES (?, ?, ?, ?, ?, 'AI', ?, ?, 'ai')`
      )
        .bind(
          task.bookKey,
          task.chapterKey,
          draft.paraIndex,
          paraHash,
          reply.author,
          reply.content,
          parentId
        )
        .run();
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`生成超时（${ms / 1000}s）`)), ms)
    ),
  ]);
}

// ─── 公开：段评详情 ───────────────────────────────────────────────

export async function handleReviewDetail(env: Env, url: URL): Promise<Response> {
  const denied = await reviewTokenGuard(env, url);
  if (denied) return denied;

  const locator = unpackParaData(url.searchParams.get("data") ?? "");
  if (!locator) return err("缺少 data 参数");

  const paraIndex = Number(url.searchParams.get("para") ?? "0");
  if (!Number.isInteger(paraIndex)) return err("para 参数非法");

  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const offset = (page - 1) * DETAIL_PAGE_SIZE;

  const rows = await env.DB.prepare(
    `SELECT * FROM reviews
      WHERE book_key = ? AND chapter_key = ? AND para_index = ? AND reply_to IS NULL
      ORDER BY id LIMIT ? OFFSET ?`
  )
    .bind(locator.bookKey, locator.chapterKey, paraIndex, DETAIL_PAGE_SIZE + 1, offset)
    .all();

  const all = (rows.results ?? []) as any[];
  const hasNext = all.length > DETAIL_PAGE_SIZE;
  const parents = hasNext ? all.slice(0, DETAIL_PAGE_SIZE) : all;

  const items = [];
  for (const parent of parents) {
    const replyRows = await env.DB.prepare(
      `SELECT * FROM reviews WHERE reply_to = ? ORDER BY id LIMIT ?`
    )
      .bind(parent.id, INLINE_REPLY_LIMIT + 1)
      .all();
    const replies = (replyRows.results ?? []) as any[];

    const countRow = (await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM reviews WHERE reply_to = ?`
    )
      .bind(parent.id)
      .first()) as any;
    const replyCount = Number(countRow?.cnt ?? 0);

    // 回复不多就直接内嵌；超过上限则只报数量，交给 getReviewReplies 分页加载
    const inline = replyCount <= INLINE_REPLY_LIMIT ? replies.slice(0, INLINE_REPLY_LIMIT) : [];

    items.push({
      ...toDetailItem(parent, replyCount),
      replies: inline.map((r) => toDetailItem(r, 0, parent.author)),
    });
  }

  return json({
    items,
    // 这里只是「还有下一页」的信号，App 会自行递增 page 再次调用
    nextPageUrl: hasNext ? `page=${page + 1}` : null,
  });
}

// ─── 公开：回复分页 ───────────────────────────────────────────────

export async function handleReviewReplies(env: Env, url: URL): Promise<Response> {
  const denied = await reviewTokenGuard(env, url);
  if (denied) return denied;

  const reviewId = Number(url.searchParams.get("id") ?? "0");
  if (!Number.isInteger(reviewId) || reviewId <= 0) return err("id 参数非法");

  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const offset = (page - 1) * REPLY_PAGE_SIZE;

  const parent = (await env.DB.prepare(`SELECT author FROM reviews WHERE id = ?`)
    .bind(reviewId)
    .first()) as any;

  const rows = await env.DB.prepare(
    `SELECT * FROM reviews WHERE reply_to = ? ORDER BY id LIMIT ? OFFSET ?`
  )
    .bind(reviewId, REPLY_PAGE_SIZE, offset)
    .all();

  return json({
    items: ((rows.results ?? []) as any[]).map((r) => toDetailItem(r, 0, parent?.author)),
  });
}

/** 组装成 App 认的结构：content 走对象协议，可带 time/likeCount/replyCount */
function toDetailItem(row: any, replyCount: number, replyToName?: string) {
  const content: Record<string, unknown> = { text: row.content };
  if (replyToName) content.replyToName = replyToName;
  if (row.created_at) content.time = formatTime(row.created_at);
  if (row.like_count > 0) content.likeCount = Number(row.like_count);
  if (replyCount > 0) content.replyCount = replyCount;

  return {
    id: String(row.id),
    name: row.author || "书友",
    avatar: row.avatar || undefined,
    badge: row.badge || undefined,
    content,
  };
}

function formatTime(raw: unknown): string {
  const text = String(raw ?? "");
  // SQLite 存 "YYYY-MM-DD HH:MM:SS"，Postgres 返回 Date 序列化后的 ISO 串
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!match) return text.slice(0, 16);
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

// ─── 管理端 ───────────────────────────────────────────────────────

export async function handleListReviewBooks(env: Env, url: URL): Promise<Response> {
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = 20;
  const offset = (page - 1) * limit;

  const [countRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(DISTINCT book_key) AS cnt FROM review_chapters`).first() as Promise<any>,
    env.DB.prepare(
      `SELECT book_key, MAX(book_name) AS book_name, MAX(author) AS author,
              COUNT(*) AS chapter_count,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM review_chapters GROUP BY book_key ORDER BY MAX(id) DESC LIMIT ? OFFSET ?`
    )
      .bind(limit, offset)
      .all(),
  ]);

  const total = Number(countRow?.cnt ?? 0);
  return ok({
    books: rows.results ?? [],
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    page,
    limit,
  });
}

export async function handleListReviews(env: Env, url: URL): Promise<Response> {
  const bookKey = url.searchParams.get("bookKey") ?? "";
  const chapterKey = url.searchParams.get("chapterKey") ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = 50;
  const offset = (page - 1) * limit;

  const where: string[] = [];
  const params: unknown[] = [];
  if (bookKey) {
    where.push("book_key = ?");
    params.push(bookKey);
  }
  if (chapterKey) {
    where.push("chapter_key = ?");
    params.push(chapterKey);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [countRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS cnt FROM reviews ${clause}`)
      .bind(...params)
      .first() as Promise<any>,
    env.DB.prepare(
      `SELECT * FROM reviews ${clause} ORDER BY para_index, id LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all(),
  ]);

  const total = Number(countRow?.cnt ?? 0);
  return ok({
    reviews: rows.results ?? [],
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    page,
    limit,
  });
}

interface AddReviewBody {
  bookName?: string;
  author?: string;
  chapterTitle?: string;
  paraIndex?: number;
  content?: string;
  penName?: string;
  replyTo?: number;
}

/** 发表人工批注。App 端段评是只读的，只能从这里写入 */
export async function handleAddReview(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<AddReviewBody>(request);
  const bookName = String(body?.bookName ?? "").trim();
  const chapterTitle = String(body?.chapterTitle ?? "").trim();
  const content = String(body?.content ?? "").trim();

  if (!bookName || !chapterTitle) return err("书名和章节标题不能为空");
  if (!content) return err("批注内容不能为空");

  const paraIndex = Number(body?.paraIndex ?? 1);
  if (!Number.isInteger(paraIndex) || (paraIndex !== -1 && paraIndex < 1)) {
    return err("段落序号非法：正文从 1 起，章节标题用 -1");
  }

  const authorName = String(body?.author ?? "").trim();
  const bookKey = await bookKeyOf(bookName, authorName);
  const chapterKey = await chapterKeyOf(chapterTitle);

  const replyTo = Number(body?.replyTo ?? 0) || null;
  if (replyTo) {
    const parent = await env.DB.prepare(`SELECT id FROM reviews WHERE id = ?`).bind(replyTo).first();
    if (!parent) return err("被回复的评论不存在");
  }

  // 章节可能还没被书源访问过，先补一条登记，管理端才列得出来
  await env.DB.prepare(
    `INSERT INTO review_chapters (book_key, chapter_key, book_name, author, chapter_title, status)
     VALUES (?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(book_key, chapter_key) DO NOTHING`
  )
    .bind(bookKey, chapterKey, bookName, authorName, chapterTitle)
    .run();

  const res = await env.DB.prepare(
    `INSERT INTO reviews (book_key, chapter_key, para_index, author, content, reply_to, origin)
     VALUES (?, ?, ?, ?, ?, ?, 'human')`
  )
    .bind(
      bookKey,
      chapterKey,
      paraIndex,
      String(body?.penName ?? "我").trim() || "我",
      content,
      replyTo
    )
    .run();

  return ok({ id: res?.meta?.last_row_id, bookKey, chapterKey });
}

export async function handleDeleteReview(env: Env, id: number): Promise<Response> {
  await env.DB.prepare(`DELETE FROM reviews WHERE id = ? OR reply_to = ?`).bind(id, id).run();
  return ok();
}

/** 清空一本书或一章的 AI 段评，人工批注保留 */
export async function handleClearAiReviews(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ bookKey?: string; chapterKey?: string }>(request);
  const bookKey = String(body?.bookKey ?? "").trim();
  if (!bookKey) return err("缺少 bookKey");

  const chapterKey = String(body?.chapterKey ?? "").trim();
  if (chapterKey) {
    await env.DB.prepare(
      `DELETE FROM reviews WHERE book_key = ? AND chapter_key = ? AND origin = 'ai'`
    )
      .bind(bookKey, chapterKey)
      .run();
    await env.DB.prepare(
      `UPDATE review_chapters SET status = 'pending', error = NULL WHERE book_key = ? AND chapter_key = ?`
    )
      .bind(bookKey, chapterKey)
      .run();
  } else {
    await env.DB.prepare(`DELETE FROM reviews WHERE book_key = ? AND origin = 'ai'`)
      .bind(bookKey)
      .run();
    await env.DB.prepare(
      `UPDATE review_chapters SET status = 'pending', error = NULL WHERE book_key = ?`
    )
      .bind(bookKey)
      .run();
  }

  return ok();
}

/**
 * 返回填好地址和令牌的书源混入脚本，直接粘进 JS 书源即可。
 * 脚本里含 review_token，所以这个接口必须走管理端鉴权，不能公开。
 * 模板文件在 assets/legado-review-mixin.js。
 */
export async function handleReviewMixinScript(request: Request, env: Env): Promise<Response> {
  return serveTemplate(request, env, "legado-review-mixin.js");
}

/** 完整 JS 书源模板：段评部分已就绪，站点规则留给使用者填 */
export async function handleReviewJsSourceTemplate(request: Request, env: Env): Promise<Response> {
  return serveTemplate(request, env, "legado-review-jssource.js");
}

/**
 * 模板放在 worker/templates 而不是 assets：
 * Dockerfile 只 COPY dist/worker/adapter，且 assets 在部署时会被挂载成数据目录，
 * 放 assets 里的文件在容器中根本不存在。
 */
async function serveTemplate(request: Request, env: Env, fileName: string): Promise<Response> {
  const origin = new URL(request.url).origin;
  const file = path.join(process.cwd(), "worker", "templates", fileName);

  let template: string;
  try {
    template = await fs.readFile(file, "utf-8");
  } catch {
    return err(`找不到模板 worker/templates/${fileName}`, 404);
  }

  const row = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_token'`
  ).first()) as any;
  const token = String(row?.value ?? "").trim();

  const script = template
    .replace(/var REVIEW_API = "[^"]*";/, `var REVIEW_API = "${origin}";`)
    .replace(/var REVIEW_TOKEN = "[^"]*";/, `var REVIEW_TOKEN = "${token}";`);

  return ok({ script });
}

// ─── 批量注入规则书源 ─────────────────────────────────────────────

/** 注入的 URL 都带这个路径，撤销时靠它认出哪些是我们写进去的 */
const INJECT_MARK = "/review/summary";

/** 认得出并剥掉我们加过的名称前缀，避免反复注入把标记叠成一串 */
const MARK_PATTERN = /^(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]+|\[评\]|\[段评\])+\s*/u;

function stripMark(name: string): string {
  return name.replace(MARK_PATTERN, "").trim();
}

function buildReviewRule(origin: string, token: string) {
  const t = token ? `&token=${encodeURIComponent(token)}` : "";
  return {
    enabled: true,
    // AnalyzeUrl.evalJS 的作用域里只有 book/page/java/source，没有 chapter，
    // 章节标题必须走 java.get("title")，写 chapter.title 会直接抛异常
    reviewSummaryUrl:
      `${origin}/review/summary?book={{encodeURIComponent(book.name)}}` +
      `&author={{encodeURIComponent(book.author)}}` +
      `&chapter={{encodeURIComponent(java.get("title"))}}${t}`,
    summaryListRule: "$.list",
    summaryParagraphIndexRule: "$.paraIndex",
    summaryCountRule: "$.count",
    summaryParagraphDataRule: "$.paraData",
    reviewDetailUrl: `${origin}/review/detail?para={{paraIndex}}&data={{paraData}}&page={{page}}${t}`,
    detailListRule: "$.items",
    detailIdRule: "$.id",
    detailNameRule: "$.name",
    detailBadgeRule: "$.badge",
    detailContentRule: "$.content",
    reviewQuoteUrl: `${origin}/review/replies?id={{reviewId}}&page={{page}}${t}`,
    replyListRule: "$.items",
    replyIdRule: "$.id",
    replyNameRule: "$.name",
    replyContentRule: "$.content",
  };
}

/**
 * 给订阅里的规则书源批量写入/撤销段评规则。
 *
 * 跳过 JS 书源：App 里段评走的是 if (isJsSource()) 走 JS 函数 else 读 ruleReview，
 * 两条路互斥，给 JS 书源写 ruleReview 是无效的，它们该用混入脚本。
 */
export async function handleInjectReviewRule(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    subscriptionId?: number;
    revoke?: boolean;
    markName?: boolean;
    mark?: string;
  }>(request);
  const revoke = body?.revoke === true;
  const subscriptionId = Number(body?.subscriptionId ?? 0) || null;

  // 换源对话框只显示 bookSourceName（tvOrigin），没有别的标记位可用，
  // 想在那里一眼认出带段评的源，只能在名字上加前缀
  const markName = body?.markName === true;
  const mark = String(body?.mark ?? "💬").trim() || "💬";

  const origin = new URL(request.url).origin;
  const tokenRow = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_token'`
  ).first()) as any;
  const token = String(tokenRow?.value ?? "").trim();

  const rows = await env.DB.prepare(
    subscriptionId
      ? `SELECT id, raw_json FROM sources WHERE subscription_id = ?`
      : `SELECT id, raw_json FROM sources`
  )
    .bind(...(subscriptionId ? [subscriptionId] : []))
    .all();

  const injectedRule = buildReviewRule(origin, token);
  let changed = 0;
  let jsSkipped = 0;
  let untouched = 0;
  let broken = 0;
  let renamed = 0;

  const pending: { id: number; json: string; name: string }[] = [];

  /** 已加过的前缀不重复叠加；撤销时逐层剥掉 */
  const applyMark = (name: string): string => {
    const bare = stripMark(name);
    if (revoke || !markName) return bare;
    return `${mark}${bare}`;
  };

  for (const row of (rows.results ?? []) as any[]) {
    let source: Record<string, unknown>;
    try {
      source = JSON.parse(row.raw_json);
    } catch {
      broken++;
      continue;
    }

    // JS 书源只认 mainJs 里的段评函数，写 ruleReview 没用
    if (String(source.mainJs ?? "").trim()) {
      jsSkipped++;
      continue;
    }

    const current = source.ruleReview as Record<string, unknown> | undefined;
    const isOurs = String(current?.reviewSummaryUrl ?? "").includes(INJECT_MARK);

    const oldName = String(source.bookSourceName ?? "");
    const newName = applyMark(oldName);
    const nameChanged = newName !== oldName;

    if (revoke) {
      // 只清我们写进去的，别人手配的段评规则不动
      if (!isOurs) {
        untouched++;
        continue;
      }
      source.ruleReview = {};
    } else {
      const ruleUpToDate = isOurs && JSON.stringify(current) === JSON.stringify(injectedRule);
      if (ruleUpToDate && !nameChanged) {
        untouched++;
        continue;
      }
      // 已有别人配好的段评规则，不覆盖
      if (current && !isOurs && String(current.reviewSummaryUrl ?? "").trim()) {
        untouched++;
        continue;
      }
      source.ruleReview = injectedRule;
    }

    if (nameChanged) {
      source.bookSourceName = newName;
      renamed++;
    }

    pending.push({ id: row.id, json: JSON.stringify(source), name: newName });
    changed++;
  }

  const BATCH = 50;
  for (let i = 0; i < pending.length; i += BATCH) {
    const chunk = pending.slice(i, i + BATCH);
    await env.DB.batch(
      chunk.map((p) =>
        env.DB.prepare(
          `UPDATE sources SET raw_json = ?, name = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(p.json, p.name, p.id)
      )
    );
  }

  if (changed > 0) await rebuildCache(env, "source");

  return ok({
    mode: revoke ? "revoke" : "inject",
    changed,
    renamed,
    jsSkipped,
    untouched,
    broken,
    hasToken: !!token,
    origin,
  });
}

/** 返回段评相关配置，供管理界面展示 */
export async function handleGetReviewConfig(env: Env): Promise<Response> {
  const cfg = await loadAiConfig(env);
  const stats = (await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM reviews WHERE origin = 'ai')    AS ai_count,
       (SELECT COUNT(*) FROM reviews WHERE origin = 'human') AS human_count,
       (SELECT COUNT(*) FROM review_chapters)                AS chapter_count,
       (SELECT COUNT(*) FROM review_chapters WHERE status = 'failed') AS failed_count`
  ).first()) as any;

  return ok({
    provider: cfg.provider,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    hasApiKey: !!cfg.apiKey,
    density: cfg.density,
    personas: cfg.personas,
    defaultPersonas: DEFAULT_PERSONAS,
    stats: {
      aiCount: Number(stats?.ai_count ?? 0),
      humanCount: Number(stats?.human_count ?? 0),
      chapterCount: Number(stats?.chapter_count ?? 0),
      failedCount: Number(stats?.failed_count ?? 0),
    },
  });
}
