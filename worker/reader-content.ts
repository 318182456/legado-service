/**
 * 借 reader 后端抓正文
 *
 * 规则书源的 reviewSummaryUrl 只能发 GET，带不了正文，所以服务端得自己去取。
 * 自己实现 legado 规则引擎不现实，而 reader（hectorqin/reader）本身就是完整的
 * legado 服务端实现，POST 时可以把书源 JSON 直接塞进 body，不需要书在它书架上。
 *
 *   POST /reader3/getChapterList  { url, bookSource } → 目录
 *   POST /reader3/getBookContent  { url, index, bookSource } → 正文
 */

import { Env } from "./types";

/** 目录缓存时长（秒）——目录很少变，但取一次要抓详情页加目录页，值得缓存 */
const TOC_CACHE_TTL = 86400;
const REQUEST_TIMEOUT_MS = 30_000;

export interface FetchContentResult {
  paragraphs: string[];
  chapterIndex: number;
  chapterTitle: string;
}

interface ReaderChapter {
  title?: string;
  url?: string;
  index?: number;
}

/** 与段评定位保持一致的标题归一化，用于在目录里找对应章节 */
export function normalizeTitle(text: string): string {
  return String(text ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[《》「」『』()（）【】\[\]]/g, "")
    .toLowerCase();
}

export async function readerPost(
  readerUrl: string,
  path: string,
  payload: Record<string, unknown>,
  accessToken?: string
): Promise<any> {
  const base = readerUrl.replace(/\/+$/, "");
  const url = `${base}/reader3${path}${accessToken ? `?accessToken=${encodeURIComponent(accessToken)}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`reader HTTP ${res.status}`);

    const data = (await res.json()) as any;
    // reader 统一返回 { isSuccess, errorMsg, data }
    if (data?.isSuccess === false) {
      throw new Error(`reader: ${data?.errorMsg ?? "未知错误"}`);
    }
    return data?.data ?? data;
  } finally {
    clearTimeout(timer);
  }
}

/** 取 reader 书架列表，用于反查 bookUrl 与书源地址 */
export async function readerGetBookshelf(
  readerUrl: string,
  accessToken?: string
): Promise<any[]> {
  const base = readerUrl.replace(/\/+$/, "");
  const url = `${base}/reader3/getBookshelf${accessToken ? `?accessToken=${encodeURIComponent(accessToken)}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
    const data = (await res.json()) as any;
    if (data?.isSuccess === false) throw new Error(`reader: ${data?.errorMsg ?? "未知错误"}`);
    const list = data?.data ?? data;
    return Array.isArray(list) ? list : [];
  } finally {
    clearTimeout(timer);
  }
}

/** 按书源 URL 从订阅库里取出完整书源 JSON */
export async function findBookSource(env: Env, originUrl: string): Promise<Record<string, unknown> | null> {
  const row = (await env.DB.prepare(
    `SELECT raw_json FROM sources WHERE book_source_url = ? ORDER BY enabled DESC, id LIMIT 1`
  )
    .bind(originUrl)
    .first()) as any;

  if (!row?.raw_json) return null;
  try {
    return JSON.parse(row.raw_json);
  } catch {
    return null;
  }
}

export async function loadToc(
  env: Env,
  readerUrl: string,
  bookUrl: string,
  bookSource: Record<string, unknown>,
  accessToken?: string
): Promise<ReaderChapter[]> {
  const cacheKey = `toc:${bookUrl}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      // 缓存坏了就重新抓
    }
  }

  const toc = await readerPost(readerUrl, "/getChapterList", { url: bookUrl, bookSource }, accessToken);
  if (!Array.isArray(toc) || !toc.length) throw new Error("目录为空");

  await env.KV.put(cacheKey, JSON.stringify(toc), { expirationTtl: TOC_CACHE_TTL });
  return toc;
}

/**
 * 用书名和章节标题定位并取回正文段落。
 * 拿不到时抛错，由调用方决定怎么记录。
 */
export async function fetchParagraphsViaReader(
  env: Env,
  opts: {
    readerUrl: string;
    accessToken?: string;
    bookUrl: string;
    originUrl: string;
    chapterTitle: string;
  }
): Promise<FetchContentResult> {
  const bookSource = await findBookSource(env, opts.originUrl);
  if (!bookSource) throw new Error(`订阅库里找不到书源 ${opts.originUrl}`);

  const toc = await loadToc(env, opts.readerUrl, opts.bookUrl, bookSource, opts.accessToken);

  const wanted = normalizeTitle(opts.chapterTitle);
  let index = toc.findIndex((c) => normalizeTitle(c?.title ?? "") === wanted);
  // 标题里带卷名或多余空格时退一步做包含匹配
  if (index < 0) {
    index = toc.findIndex((c) => {
      const t = normalizeTitle(c?.title ?? "");
      return t.length > 0 && (t.includes(wanted) || wanted.includes(t));
    });
  }
  if (index < 0) throw new Error(`目录里找不到章节「${opts.chapterTitle}」`);

  const content = await readerPost(
    opts.readerUrl,
    "/getBookContent",
    { url: opts.bookUrl, index, bookSource },
    opts.accessToken
  );

  const text = typeof content === "string" ? content : String(content ?? "");
  if (!text.trim()) throw new Error("正文为空");

  return {
    paragraphs: splitParagraphs(text),
    chapterIndex: index,
    chapterTitle: String(toc[index]?.title ?? opts.chapterTitle),
  };
}

/** 与书源脚本里的分段规则保持一致，否则段号会错位 */
export function splitParagraphs(text: string): string[] {
  return String(text)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s　]+/, "").replace(/[\s　]+$/, ""))
    .filter(Boolean);
}

// ─── 登录 ─────────────────────────────────────────────────────────

/** reader 的 token 缓存时长（秒）。它自己的有效期更长，这里短一些以便及时换新 */
const TOKEN_CACHE_TTL = 3 * 86400;

/** reader 报的这几种错都意味着要重新登录 */
export function isReaderAuthError(message: string): boolean {
  return /NEED_LOGIN|请登录|登录后使用|token.*(过期|失效)/i.test(message);
}

/**
 * 用用户名密码登录 reader，返回它认的 accessToken（格式为 username:token）。
 * isLogin 必须为 true——传 false 时 reader 会走注册流程，可能凭空建出用户。
 */
export async function readerLogin(
  readerUrl: string,
  username: string,
  password: string
): Promise<string> {
  const base = readerUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/reader3/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, isLogin: true }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`登录 reader 失败：HTTP ${res.status}`);

    const data = (await res.json()) as any;
    if (data?.isSuccess === false) {
      throw new Error(`登录 reader 失败：${data?.errorMsg ?? "未知错误"}`);
    }
    const user = data?.data ?? data;
    const token = String(user?.token ?? "").trim();
    const name = String(user?.username ?? username).trim();
    if (!token) throw new Error("登录 reader 成功但未返回 token");

    return `${name}:${token}`;
  } finally {
    clearTimeout(timer);
  }
}

/** 丢弃缓存的 token，下次请求会重新登录 */
export async function clearReaderToken(env: Env, username: string): Promise<void> {
  await env.KV.delete(`reader_token:${username}`);
}

/**
 * reader 地址优先取配置，回落到部署时的 READER_URL。
 * 配了用户名密码就自动登录换 token 并缓存；显式填的 accessToken 优先级最高。
 */
export async function resolveReaderConfig(
  env: Env
): Promise<{ readerUrl: string; accessToken?: string; username?: string } | null> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM system_config
      WHERE key IN ('reader_url', 'reader_access_token', 'review_auto_fetch',
                    'reader_username', 'reader_password')`
  ).all();

  const cfg: Record<string, string> = {};
  for (const r of (rows.results ?? []) as any[]) cfg[r.key] = r.value ?? "";

  // 默认开启，显式设为 '0' 才关闭
  if (cfg["review_auto_fetch"] === "0") return null;

  const readerUrl = (cfg["reader_url"] || env.READER_URL || "").trim();
  if (!readerUrl) return null;

  const explicit = cfg["reader_access_token"]?.trim();
  if (explicit) return { readerUrl, accessToken: explicit };

  const username = cfg["reader_username"]?.trim();
  const password = cfg["reader_password"]?.trim();
  if (!username || !password) return { readerUrl };

  const cacheKey = `reader_token:${username}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return { readerUrl, accessToken: cached, username };

  try {
    const token = await readerLogin(readerUrl, username, password);
    await env.KV.put(cacheKey, token, { expirationTtl: TOKEN_CACHE_TTL });
    console.log(`[段评] 已登录 reader，用户 ${username}`);
    return { readerUrl, accessToken: token, username };
  } catch (e) {
    console.error(`[段评] ${(e as Error).message}`);
    // 登录失败也把地址返回，让后续步骤报出更具体的错误
    return { readerUrl, username };
  }
}
