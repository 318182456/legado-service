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

// ─── 章节标题匹配 ─────────────────────────────────────────────────

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9, 两: 2,
};

const CN_UNITS: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000, 亿: 100000000 };

const CN_NUM_CHARS = Object.keys(CN_DIGITS).concat(Object.keys(CN_UNITS)).join("");

/** 「五百七十九」→ 579。解析不出返回 null */
export function cnToNumber(text: string): number | null {
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);

  let total = 0;
  let section = 0;
  let num = 0;
  let seen = false;

  for (const ch of text) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch];
      seen = true;
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      seen = true;
      if (unit >= 10000) {
        section = (section + num) * unit;
        total += section;
        section = 0;
      } else {
        // 「十九」这种省略了前导一
        section += (num || 1) * unit;
      }
      num = 0;
    } else {
      return null;
    }
  }

  return seen ? total + section + num : null;
}

/**
 * 从章节标题里取出序号，中文数字与阿拉伯数字都认。
 * 小说站两种写法混用极常见，同一本书在 App 与 reader 里可能各用一种。
 */
export function extractChapterNumber(title: string): number | null {
  const t = String(title ?? "");

  const marked = t.match(new RegExp(`第\\s*([0-9]+|[${CN_NUM_CHARS}]+)\\s*[章节回话卷篇]`));
  if (marked) return cnToNumber(marked[1]);

  const leading = t.match(/^\s*(\d{1,6})\s*[.、,，:：\s]/);
  if (leading) return Number(leading[1]);

  return null;
}

/** 去掉「第N章」前缀后的标题正文，用于跨编号写法比对 */
export function chapterTitleBody(title: string): string {
  const stripped = String(title ?? "").replace(
    new RegExp(`^\\s*第\\s*(?:[0-9]+|[${CN_NUM_CHARS}]+)\\s*[章节回话卷篇]\\s*[:：、.]?\\s*`),
    ""
  );
  return normalizeTitle(stripped);
}

export interface ChapterMatch {
  index: number;
  how: string;
}

/**
 * 在目录里定位章节。按可靠度从高到低尝试，任一命中即返回。
 * 宁可返回 null 也不能瞎猜——钉错段落比没有段评更糟。
 */
export function matchChapter(toc: { title?: string }[], wantTitle: string): ChapterMatch | null {
  const wantFull = normalizeTitle(wantTitle);
  const wantNum = extractChapterNumber(wantTitle);
  const wantBody = chapterTitleBody(wantTitle);

  const exact = toc.findIndex((c) => normalizeTitle(c?.title ?? "") === wantFull);
  if (exact >= 0) return { index: exact, how: "标题完全一致" };

  // 序号与正文同时对上，最可信
  if (wantNum !== null && wantBody) {
    const both = toc.findIndex(
      (c) =>
        extractChapterNumber(c?.title ?? "") === wantNum &&
        chapterTitleBody(c?.title ?? "") === wantBody
    );
    if (both >= 0) return { index: both, how: `序号 ${wantNum} 与标题正文均一致` };
  }

  // 正文足够长时单凭正文也够独特
  if (wantBody.length >= 3) {
    const hits = toc
      .map((c, i) => ({ i, body: chapterTitleBody(c?.title ?? "") }))
      .filter((x) => x.body === wantBody);
    if (hits.length === 1) return { index: hits[0].i, how: "标题正文一致（忽略编号写法）" };
  }

  // 只剩序号可用，且该序号在目录里唯一
  if (wantNum !== null) {
    const hits = toc
      .map((c, i) => ({ i, n: extractChapterNumber(c?.title ?? "") }))
      .filter((x) => x.n === wantNum);
    if (hits.length === 1) return { index: hits[0].i, how: `章节序号 ${wantNum} 唯一匹配` };
  }

  // 最后退到包含匹配，要求长度足够避免误伤
  if (wantFull.length >= 4) {
    const loose = toc.findIndex((c) => {
      const t = normalizeTitle(c?.title ?? "");
      return t.length >= 4 && (t.includes(wantFull) || wantFull.includes(t));
    });
    if (loose >= 0) return { index: loose, how: "包含匹配" };
  }

  return null;
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

  const matched = matchChapter(toc, opts.chapterTitle);
  if (!matched) throw new Error(`目录里找不到章节「${opts.chapterTitle}」`);
  const index = matched.index;
  console.log(`[段评] 章节定位：${matched.how} → index=${index}「${toc[index]?.title}」`);

  const content = await readerPost(
    opts.readerUrl,
    "/getBookContent",
    { url: opts.bookUrl, index, bookSource },
    opts.accessToken
  );

  const text = typeof content === "string" ? content : String(content ?? "");
  if (!text.trim()) throw new Error("正文为空");

  return {
    paragraphs: splitParagraphs(text, String(toc[index]?.title ?? opts.chapterTitle)),
    chapterIndex: index,
    chapterTitle: String(toc[index]?.title ?? opts.chapterTitle),
  };
}

/** 与书源脚本里的分段规则保持一致，否则段号会错位 */
export function splitParagraphs(text: string, chapterTitle?: string): string[] {
  const lines = String(text)
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

  return stripLeadingTitle(lines, chapterTitle);
}

/**
 * 有些源会把章节标题混进正文首行（还常带「(第1/3页)」这类分页标记），
 * 而 App 的正文不含标题行 —— 不剔掉的话所有段号整体偏移 1，段评全部错位。
 */
function stripLeadingTitle(lines: string[], chapterTitle?: string): string[] {
  if (!lines.length) return lines;

  const first = lines[0];
  // 去掉分页标记后再比对，「第580章 散装人偶 (第1/3页)」→「第580章 散装人偶」
  const bare = first
    .replace(/[(（]\s*第?\s*\d+\s*[/／]\s*\d+\s*页?\s*[)）]\s*$/, "")
    .trim();

  const looksLikeTitle =
    // 与章节标题一致（含中文数字与阿拉伯数字混用的情形）
    (!!chapterTitle &&
      (normalizeTitle(bare) === normalizeTitle(chapterTitle) ||
        (chapterTitleBody(bare).length > 0 &&
          chapterTitleBody(bare) === chapterTitleBody(chapterTitle)))) ||
    // 没传标题时，退而识别「第N章 …」且够短的首行。
    // 必须整行都像标题：正文里「第三章说的那件事…」这种也以第N章开头，不能误删
    (!chapterTitle &&
      bare.length <= 40 &&
      /^第\s*[0-9〇零一二三四五六七八九十百千万]+\s*[章节回话卷篇][\s:：、.]*[^，。！？；,.!?;]*$/.test(bare));

  return looksLikeTitle ? lines.slice(1) : lines;
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
