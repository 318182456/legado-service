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
import {
  buildAnchor,
  packAnchor,
  unpackAnchor,
  buildIndex,
  locate,
  type MatchLevel,
} from "../para-anchor";
import { ok, err, json, parseBody, hashText, rebuildCache } from "../utils";
import {
  loadAiConfig,
  createGenerator,
  DEFAULT_PERSONAS,
  describeEndpoint,
  detectProvider,
  type ReviewDraft,
} from "../review-ai";
import {
  fetchParagraphsViaReader,
  resolveReaderConfig,
  findBookSource,
  loadToc,
  readerPost,
  normalizeTitle,
  splitParagraphs,
  readerGetBookshelf,
  isReaderAuthError,
  clearReaderToken,
  matchChapter,
  extractChapterNumber,
} from "../reader-content";

/**
 * 首次请求的同步等待上限。
 *
 * App 把空结果也写进 reviewSummaryCache，不退书架就不再请求这一章，
 * 所以首次得等一下。之前 20s 太长，6s 能赶上大部分生成。
 */
const SYNC_WAIT_MS = 6_000;

const DETAIL_PAGE_SIZE = 20;
const REPLY_PAGE_SIZE = 20;
const GENERATE_TIMEOUT_MS = 45_000;
/** 内嵌回复的条数上限，超过则改由 getReviewReplies 分页拉取 */
const INLINE_REPLY_LIMIT = 3;
/**
 * 首次请求时同步等待生成的时长。
 * App 会缓存空结果且不再重试，等到就能当场返回，省去退出重进。
 * 上限要留在 AnalyzeUrl 的请求超时之内，超了不如转后台。
 */

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
  if (provided !== expected) {
    console.warn(
      `[段评] 令牌校验失败，请求被拒：${url.pathname}` +
        `（收到 ${provided ? `"${provided.slice(0, 4)}…"` : "空"}）。` +
        `书源里的 URL 可能是改令牌之前注入的，重新注入一次即可`
    );
    return err("Invalid review token", 401);
  }
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
function packParaData(
  bookKey: string,
  chapterKey: string,
  /** 该段校正前的原始段号，不传表示未经校正 */
  origins?: number[]
): string {
  const base = `${bookKey}.${chapterKey}`;
  // 把映射编进 paraData，App 会原样回传 —— detail 就不必依赖
  // 服务端内存。之前靠进程内 alignCache，进程重启或多副本
  // 部署时两次请求落到不同实例，反查就空，App 上显示「文章内容为空」。
  if (!origins?.length) return base;
  return `${base}.${origins.join("-")}`;
}

function unpackParaData(
  data: string
): { bookKey: string; chapterKey: string; origins?: number[] } | null {
  const parts = String(data || "").split(".");
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const out: { bookKey: string; chapterKey: string; origins?: number[] } = {
    bookKey: parts[0],
    chapterKey: parts[1],
  };
  if (parts[2]) {
    const origins = parts[2]
      .split("-")
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n));
    if (origins.length) out.origins = origins;
  }
  return out;
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
  // 否则一章只要先有了人工批注，AI 就永远轮不到生成。
  //
  // 同步等一下（上限 SYNC_WAIT_MS）：赶上生成就当场带回，
  // 否则 App 会缓存空结果，要退出重进才看得到。
  if (paragraphs.length) {
    await Promise.race([
      generateIfNeeded(env, {
        bookKey,
        chapterKey,
        bookName,
        author,
        chapterTitle,
        paragraphs,
        force,
      }),
      new Promise((r) => setTimeout(r, SYNC_WAIT_MS)),
    ]);
  }

  // 请求方给了正文就按段落原文实时定位，避免两侧分段不同导致的错位
  const list = paragraphs.length
    ? await summarizeAligned(env, bookKey, chapterKey, paraData, paragraphs)
    : await summarize(env, bookKey, chapterKey, paraData);

  return json({ list });
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
  const paraDataStr = packParaData(bookKey, chapterKey);

  // 规则书源发的是 GET、带不了正文，锚点校正就无从谈起，
  // App 只能拿到生成时的原始段号 —— 两侧分段一有出入就整体错位。
  // 这里主动取一次 App 侧的正文（reader 抓的那份有缓存），据此实时定位。
  const aligned = await alignWithFetchedContent(env, {
    bookKey,
    chapterKey,
    chapterTitle,
    paraData: paraDataStr,
    bookUrl: (url.searchParams.get("bookUrl") ?? "").trim(),
    originUrl: (url.searchParams.get("origin") ?? "").trim(),
  });
  const list = aligned ?? (await summarize(env, bookKey, chapterKey, paraDataStr));

  // 规则书源带不了正文，改由服务端借 reader 去抓，然后自行生成。
  // 这一步不阻塞响应：抓目录 + 抓正文 + 调模型远超 App 的请求超时，
  // 先把现有结果返回，生成完下次进这一章（或翻页回来）就有了。
  const bookUrl = (url.searchParams.get("bookUrl") ?? "").trim();
  const originUrl = (url.searchParams.get("origin") ?? "").trim();

  console.log(
    `[段评] 统计查询 《${bookName}》${author ? `(${author})` : ""} - ${chapterTitle}` +
      ` → 命中 ${list.length} 段` +
      (bookUrl && originUrl ? " ，触发后台抓取" : " ，未带 bookUrl/origin（旧注入规则，不会自动生成）")
  );

  if (bookUrl && originUrl) {
    // 先把定位信息记下来：诊断和后续补生成就不用再手工输入
    await rememberChapterLocation(env, {
      bookKey,
      chapterKey,
      bookName,
      author,
      chapterTitle,
      bookUrl,
      originUrl,
    });

    const task = {
      bookKey,
      chapterKey,
      bookName,
      author,
      chapterTitle,
      bookUrl,
      originUrl,
    };

    // App 会把空结果写进 reviewSummaryCache，不退书架就不再请求这一章，
    // 所以首次得同步等一会儿，赶上生成就当场带回。
    //
    // 之前担心这个等待会拖住 App 的进度同步，一度改成完全不等 —— 结果
    // 段评要退出重进才看得到。进度那个问题的真凶是 reader 取正文时写了
    // durChapterIndex（已由 cache=1 修掉），与这里无关。
    // 等待时长从 20s 收到 6s：赶得上大部分生成，又不至于让人察觉卡顿。
    const generated = await Promise.race([
      autoGenerateViaReader(env, task).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), SYNC_WAIT_MS)),
    ]);
    if (generated) {
      const fresh = await summarize(env, bookKey, chapterKey, paraDataStr);
      if (fresh.length) {
        console.log(
          `[段评] 同步生成完成，本次直接带回 ${fresh.length} 段` +
            `（《${bookName}》- ${chapterTitle}）`
        );
        void schedulePrefetch(env, { bookKey, bookName, author, chapterTitle, bookUrl, originUrl });
        return json({ list: fresh });
      }
    }
    void schedulePrefetch(env, { bookKey, bookName, author, chapterTitle, bookUrl, originUrl });
  }

  return json({ list });
}

/**
 * 把 reader 目录标题改写成与来访者同一种编号写法。
 *
 * App 用「第五百八十一章 …」，reader 目录是「第581章 …」，
 * 两者算出的 chapterKey 不同。预生成若直接用目录标题落库，
 * App 永远读不到那批数据，只能自己再生成一次 —— 白烧额度还容易串章。
 */
function alignTitleStyle(tocTitle: string, sampleTitle: string): string {
  const tocNum = extractChapterNumber(tocTitle);
  if (tocNum === null) return tocTitle;

  // 来访者用的是中文数字还是阿拉伯数字
  const sampleUsesCn = /第\s*[〇零一二三四五六七八九十百千万]+\s*[章节回话卷篇]/.test(sampleTitle);
  const tocUsesCn = /第\s*[〇零一二三四五六七八九十百千万]+\s*[章节回话卷篇]/.test(tocTitle);
  if (sampleUsesCn === tocUsesCn) return tocTitle;

  const body = tocTitle.replace(
    /^\s*第\s*(?:[0-9]+|[〇零一二三四五六七八九十百千万]+)\s*([章节回话卷篇])\s*/,
    ""
  );
  const unit = tocTitle.match(/第\s*(?:[0-9]+|[〇零一二三四五六七八九十百千万]+)\s*([章节回话卷篇])/)?.[1] ?? "章";
  const num = sampleUsesCn ? numberToCn(tocNum) : String(tocNum);
  return `第${num}${unit} ${body}`.trim();
}

/** 579 → 五百七十九 */
function numberToCn(n: number): string {
  if (n <= 0) return String(n);
  const d = "零一二三四五六七八九";
  const units = ["", "十", "百", "千"];
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const digit = Number(s[i]);
    const pos = s.length - 1 - i;
    if (digit === 0) {
      if (out && !out.endsWith("零")) out += "零";
      continue;
    }
    // 十几读作「十九」而非「一十九」
    if (!(digit === 1 && pos === 1 && i === 0)) out += d[digit];
    out += units[pos] ?? "";
  }
  return out.replace(/零+$/, "");
}

/** 读配置决定预生成章数，0 表示关闭 */
async function schedulePrefetch(
  env: Env,
  opts: {
    bookKey: string;
    bookName: string;
    author: string;
    chapterTitle: string;
    bookUrl: string;
    originUrl: string;
  }
): Promise<void> {
  const row = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_prefetch'`
  ).first()) as any;
  const count = Number(row?.value ?? "2");
  if (!Number.isFinite(count) || count <= 0) return;

  await prefetchNextChapters(env, { ...opts, count: Math.min(10, count) });
}

/**
 * 预生成后续章节。
 *
 * 读者读到第 N 章时，把 N+1…N+prefetch 章一并生成好，翻页过去就是现成的，
 * 不必再等那十几秒。逐章串行，避免同时打爆 reader 与模型接口。
 */
async function prefetchNextChapters(
  env: Env,
  opts: {
    bookKey: string;
    bookName: string;
    author: string;
    chapterTitle: string;
    bookUrl: string;
    originUrl: string;
    count: number;
  }
): Promise<void> {
  try {
    const readerCfg = await resolveReaderConfig(env);
    if (!readerCfg) return;

    const bookSource = await findBookSource(env, opts.originUrl);
    if (!bookSource) return;

    const toc = await withReaderRetry(env, readerCfg, (token) =>
      loadToc(env, readerCfg.readerUrl, opts.bookUrl, bookSource, token)
    );
    const here = matchChapter(toc, opts.chapterTitle);
    if (!here) return;

    for (let i = 1; i <= opts.count; i++) {
      const idx = here.index + i;
      if (idx >= toc.length) break;

      const rawTitle = String(toc[idx]?.title ?? "").trim();
      if (!rawTitle) continue;
      // 与来访者（App）保持同一种编号写法，否则算出的键对不上
      const title = alignTitleStyle(rawTitle, opts.chapterTitle);

      const chapterKey = await chapterKeyOf(title);
      const row = (await env.DB.prepare(
        `SELECT status FROM review_chapters WHERE book_key = ? AND chapter_key = ?`
      )
        .bind(opts.bookKey, chapterKey)
        .first()) as any;
      // 已处理过就跳过，预生成不该重复烧额度
      if (row?.status && row.status !== "pending") continue;

      // 用目录标题本身作为键与落库标题，确保「取正文的那一章」
      // 与「落库的那一章」是同一个 —— 两次定位若结果不同就会串章
      console.log(`[段评] 预生成《${opts.bookName}》- ${title}（目录 index=${idx}）`);
      await rememberChapterLocation(env, {
        bookKey: opts.bookKey,
        chapterKey,
        bookName: opts.bookName,
        author: opts.author,
        chapterTitle: title,
        bookUrl: opts.bookUrl,
        originUrl: opts.originUrl,
      });
      await autoGenerateViaReader(env, {
        bookKey: opts.bookKey,
        chapterKey,
        bookName: opts.bookName,
        author: opts.author,
        chapterTitle: title,
        bookUrl: opts.bookUrl,
        originUrl: opts.originUrl,
      });
    }
  } catch (e) {
    console.error(`[段评] 预生成失败《${opts.bookName}》:`, (e as Error).message);
  }
}

/**
 * 规则书源专用：自己取一次正文，按段落原文实时定位段号。
 *
 * JS 书源会把 App 的段落 POST 上来，规则书源只能发 GET，于是校正无从谈起。
 * 这里退而用 reader 抓的正文比对，能纠正「生成后正文有变动」一类的偏差。
 *
 * 但要清楚它的上限：reader 与 App 对同一份 HTML 的分段本就可能不同
 * （实测某章 App 把一句话按源站换行拆成两段，reader 合成一段，后续整体差 3），
 * 这种差异用 reader 的正文校不出来 —— 唯一可靠的参照是 App 自己的段落。
 * 要根治只能让该书源改用 JS 书源，由 getReviewSummary 把 App 的段落投喂上来。
 */
async function alignWithFetchedContent(
  env: Env,
  opts: {
    bookKey: string;
    chapterKey: string;
    chapterTitle: string;
    paraData: string;
    bookUrl: string;
    originUrl: string;
  }
): Promise<{ paraIndex: number; count: number; paraData: string }[] | null> {
  // 这条路整个失效时只会默默回退到原始段号，日志里看不出任何线索，
  // 所以每个退出点都要报出原因
  if (!opts.bookUrl || !opts.originUrl) {
    console.log(
      `[段评] 无法校正段号：缺参数 ${!opts.bookUrl ? "bookUrl" : ""}${!opts.bookUrl && !opts.originUrl ? " " : ""}${!opts.originUrl ? "origin" : ""}` +
        `（书源里的 URL 规则需重新注入）`
    );
    return null;
  }

  try {
    const readerCfg = await resolveReaderConfig(env);
    if (!readerCfg) {
      console.log("[段评] 无法校正段号：reader 未配置");
      return null;
    }

    // reader 就是 legado 内核，分页、净化、各类规则语法都由它处理，
    // 分段与 App 同源；残余差异交给五级锚点定位
    let paragraphs: string[];
    {
      const fetched = await withReaderRetry(env, readerCfg, (token) =>
        fetchParagraphsViaReader(env, {
          readerUrl: readerCfg.readerUrl,
          accessToken: token,
          bookUrl: opts.bookUrl,
          originUrl: opts.originUrl,
          chapterTitle: opts.chapterTitle,
        })
      );
      paragraphs = fetched.paragraphs;
      console.log(`[段评] 借 reader 取到 ${paragraphs.length} 段用于校正`);
    }
    if (!paragraphs.length) {
      console.log("[段评] 无法校正段号：取到的正文为空");
      return null;
    }

    return await summarizeAligned(
      env,
      opts.bookKey,
      opts.chapterKey,
      opts.paraData,
      paragraphs
    );
  } catch (e) {
    console.error(`[段评] 取正文校正段号失败：${(e as Error).message}`);
    return null;
  }
}

/** 登记章节的 bookUrl / origin，不覆盖已有的生成状态 */
async function rememberChapterLocation(
  env: Env,
  opts: {
    bookKey: string;
    chapterKey: string;
    bookName: string;
    author: string;
    chapterTitle: string;
    bookUrl: string;
    originUrl: string;
  }
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO review_chapters
         (book_key, chapter_key, book_name, author, chapter_title, book_url, origin_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(book_key, chapter_key) DO UPDATE SET
         book_url = excluded.book_url,
         origin_url = excluded.origin_url,
         book_name = excluded.book_name,
         author = excluded.author,
         chapter_title = excluded.chapter_title`
    )
      .bind(
        opts.bookKey,
        opts.chapterKey,
        opts.bookName,
        opts.author,
        opts.chapterTitle,
        opts.bookUrl,
        opts.originUrl
      )
      .run();
  } catch (e) {
    console.error("[段评] 记录章节定位信息失败:", (e as Error).message);
  }
}

/**
 * 诊断没填 bookUrl 时的反查顺序：
 * 1. 本章此前被 App 请求过 → review_chapters 里有记录
 * 2. 同一本书的其它章节有记录 → 复用它的 bookUrl
 * 3. reader 书架上有这本书 → 按书名作者匹配
 */
interface BookLocation {
  bookUrl?: string;
  originUrl?: string;
  from?: string;
  failReason?: string;
}

async function resolveBookLocation(
  env: Env,
  opts: { bookKey: string; chapterKey: string; bookName: string; author: string }
): Promise<BookLocation> {
  const exact = (await env.DB.prepare(
    `SELECT book_url, origin_url FROM review_chapters
      WHERE book_key = ? AND chapter_key = ? AND book_url IS NOT NULL AND origin_url IS NOT NULL`
  )
    .bind(opts.bookKey, opts.chapterKey)
    .first()) as any;
  if (exact?.book_url) {
    return { bookUrl: exact.book_url, originUrl: exact.origin_url, from: "本章此前的请求记录" };
  }

  const sameBook = (await env.DB.prepare(
    `SELECT book_url, origin_url FROM review_chapters
      WHERE book_key = ? AND book_url IS NOT NULL AND origin_url IS NOT NULL
      ORDER BY id DESC LIMIT 1`
  )
    .bind(opts.bookKey)
    .first()) as any;
  if (sameBook?.book_url) {
    return { bookUrl: sameBook.book_url, originUrl: sameBook.origin_url, from: "同书其它章节的记录" };
  }

  // 最后试 reader 书架
  const readerCfg = await resolveReaderConfig(env);
  if (!readerCfg) {
    return { failReason: "自动抓取已关闭或 reader 地址为空，无法查书架" };
  }

  try {
    const shelf = await withReaderRetry(env, readerCfg, (token) =>
      readerGetBookshelf(readerCfg.readerUrl, token)
    );
    console.log(`[段评] 为《${opts.bookName}》查 reader 书架，返回 ${shelf.length} 本书`);

    if (!shelf.length) {
      return {
        failReason:
          "reader 书架返回 0 本书。若你在网页上能看到书架，多半是 reader 开了多用户，" +
          "需要在配置里填 reader accessToken",
      };
    }

    const wantName = normalizeTitle(opts.bookName);
    const wantAuthor = normalizeTitle(opts.author);

    // 先按书名+作者，再退一步只按书名
    let hit = shelf.find(
      (b: any) =>
        normalizeTitle(b?.name ?? "") === wantName &&
        (!wantAuthor || normalizeTitle(b?.author ?? "") === wantAuthor)
    );
    let how = "书名+作者";
    if (!hit) {
      hit = shelf.find((b: any) => normalizeTitle(b?.name ?? "") === wantName);
      how = "仅书名";
    }

    if (!hit) {
      const names = shelf.slice(0, 8).map((b: any) => b?.name).filter(Boolean).join("、");
      return {
        failReason: `reader 书架共 ${shelf.length} 本，其中没有《${opts.bookName}》。书架样例：${names}`,
      };
    }
    if (!hit.bookUrl || !hit.origin) {
      return {
        failReason: `书架里找到《${opts.bookName}》，但缺少 ${
          !hit.bookUrl ? "bookUrl" : "origin"
        }（可能是本地书）`,
      };
    }

    return { bookUrl: hit.bookUrl, originUrl: hit.origin, from: `reader 书架（${how}匹配）` };
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[段评] 为《${opts.bookName}》查 reader 书架失败：${msg}`);
    return { failReason: `查 reader 书架失败：${msg}` };
  }
}

/**
 * reader 的 token 会过期。撞到登录错误时清掉缓存重登一次，
 * 否则一旦过期就要等缓存自然到期才能恢复。
 */
async function withReaderRetry<T>(
  env: Env,
  cfg: { readerUrl: string; accessToken?: string; username?: string },
  fn: (token?: string) => Promise<T>
): Promise<T> {
  try {
    return await fn(cfg.accessToken);
  } catch (e) {
    const msg = (e as Error).message;
    if (!cfg.username || !isReaderAuthError(msg)) throw e;

    console.warn(`[段评] reader token 似已失效（${msg}），重新登录后重试`);
    await clearReaderToken(env, cfg.username);
    const fresh = await resolveReaderConfig(env);
    if (!fresh?.accessToken) throw e;
    return await fn(fresh.accessToken);
  }
}

/**
 * 检查某个书源在订阅输出里的段评规则状态。
 * App 侧不发请求时用来做排除法：先确认服务端的数据本身没问题。
 */
export async function handleCheckSourceStatus(request: Request, env: Env, url: URL): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return err("请输入书源名或书源地址");

  const rows = await env.DB.prepare(
    `SELECT id, name, book_source_url, raw_json, enabled FROM sources
      WHERE name LIKE ? OR book_source_url LIKE ? ORDER BY enabled DESC, id LIMIT 10`
  )
    .bind(`%${q}%`, `%${q}%`)
    .all();

  const bookName = (url.searchParams.get("book") ?? "示例书名").trim();
  const chapterTitle = (url.searchParams.get("chapter") ?? "第一章").trim();
  const author = (url.searchParams.get("author") ?? "").trim();

  const tokenRow = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_token'`
  ).first()) as any;
  const token = String(tokenRow?.value ?? "").trim();
  const origin = publicOrigin(request);

  const matches = [];
  for (const row of (rows.results ?? []) as any[]) {
    let src: any = {};
    try {
      src = JSON.parse(row.raw_json);
    } catch {
      matches.push({ name: row.name, bookSourceUrl: row.book_source_url, broken: true });
      continue;
    }

    const isJs = !!String(src.mainJs ?? "").trim();
    const rr = src.ruleReview ?? null;

    // 与 App 的 ReviewRule.configuredSummaryUrl() 保持一致的必填项
    const required = [
      "reviewSummaryUrl",
      "summaryListRule",
      "summaryParagraphIndexRule",
      "summaryCountRule",
    ];
    const missing = rr ? required.filter((k) => !String(rr[k] ?? "").trim()) : required;
    const usable = !isJs && !!rr && rr.enabled === true && missing.length === 0;

    // 拼一条可以直接丢进浏览器验证的地址
    let probeUrl = "";
    if (usable) {
      const params = new URLSearchParams({
        book: bookName,
        author,
        chapter: chapterTitle,
        bookUrl: "",
        origin: row.book_source_url,
      });
      if (token) params.set("token", token);
      probeUrl = `${origin}/review/summary?${params}`;
    }

    matches.push({
      name: row.name,
      bookSourceUrl: row.book_source_url,
      enabled: row.enabled === 1,
      isJsSource: isJs,
      hasReviewRule: !!rr,
      reviewEnabled: rr?.enabled === true,
      missingFields: missing,
      usable,
      probeUrl,
      summaryUrl: rr?.reviewSummaryUrl ?? "",
    });
  }

  return ok({ query: q, total: matches.length, matches });
}

/** 列出 reader 书架，供诊断界面点选书籍 */
export async function handleListReaderShelf(env: Env): Promise<Response> {
  const readerCfg = await resolveReaderConfig(env);
  if (!readerCfg) {
    return err("自动抓取已关闭或 reader 地址为空", 400);
  }

  try {
    const shelf = await withReaderRetry(env, readerCfg, (token) =>
      readerGetBookshelf(readerCfg.readerUrl, token)
    );
    return ok({
      readerUrl: readerCfg.readerUrl,
      total: shelf.length,
      books: shelf
        .map((b: any) => ({
          name: String(b?.name ?? ""),
          author: String(b?.author ?? ""),
          bookUrl: String(b?.bookUrl ?? ""),
          origin: String(b?.origin ?? ""),
          originName: String(b?.originName ?? ""),
          durChapterTitle: String(b?.durChapterTitle ?? ""),
        }))
        .filter((b: any) => b.name),
    });
  } catch (e) {
    return err(`查 reader 书架失败：${(e as Error).message}`, 502);
  }
}

/**
 * 借 reader 抓正文并生成本章段评。后台执行，异常只记日志。
 * 章节状态锁保证同一章不会被并发重复处理。
 */
async function autoGenerateViaReader(
  env: Env,
  opts: {
    bookKey: string;
    chapterKey: string;
    bookName: string;
    author: string;
    chapterTitle: string;
    bookUrl: string;
    originUrl: string;
  }
): Promise<void> {
  const tag = `《${opts.bookName}》- ${opts.chapterTitle}`;
  try {
    const cfg = await loadAiConfig(env);
    if (!cfg.apiKey) {
      console.log(`[段评] ${tag} 跳过抓取：未配置模型 API Key`);
      return;
    }

    // 先看状态，避免为已处理过的章节白跑一趟 reader
    const row = (await env.DB.prepare(
      `SELECT status FROM review_chapters WHERE book_key = ? AND chapter_key = ?`
    )
      .bind(opts.bookKey, opts.chapterKey)
      .first()) as any;
    if (row?.status && row.status !== "pending") {
      console.log(
        `[段评] ${tag} 跳过抓取：章节状态为 ${row.status}` +
          (row.status === "failed" ? "（此前失败过，清空本书 AI 段评可重试）" : "")
      );
      return;
    }

    const readerCfg = await resolveReaderConfig(env);
    if (!readerCfg) {
      console.log(`[段评] ${tag} 跳过抓取：自动抓取已关闭或 reader 地址为空`);
      return;
    }

    console.log(`[段评] ${tag} 开始借 reader 抓正文 → ${readerCfg.readerUrl}`);
    const fetched = await withReaderRetry(env, readerCfg, (token) =>
      fetchParagraphsViaReader(env, {
        readerUrl: readerCfg.readerUrl,
        accessToken: token,
        bookUrl: opts.bookUrl,
        originUrl: opts.originUrl,
        chapterTitle: opts.chapterTitle,
      })
    );

    if (!fetched.paragraphs.length) {
      console.warn(`[段评] ${tag} 正文分段后为空，放弃`);
      return;
    }

    // 段号是按这份正文算的，App 的分段若与之不同，评论就会钉错段落。
    // 分页正文尤其容易少抓，这里留一条日志，段数明显偏少时给出警示。
    if (fetched.paragraphs.length < 20) {
      console.warn(
        `[段评] ${tag} 正文仅 ${fetched.paragraphs.length} 段，疑似分页未抓全，` +
          `段评可能与 App 的段落对不上`
      );
    }
    console.log(
      `[段评] ${tag} 已取到正文：index=${fetched.chapterIndex}，${fetched.paragraphs.length} 段，开始生成`
    );

    await generateIfNeeded(env, {
      bookKey: opts.bookKey,
      chapterKey: opts.chapterKey,
      bookName: opts.bookName,
      author: opts.author,
      chapterTitle: opts.chapterTitle,
      paragraphs: fetched.paragraphs,
    });
  } catch (e) {
    console.error(
      `自动抓取正文失败 [${opts.bookName} - ${opts.chapterTitle}]:`,
      (e as Error).message
    );
  }
}

/**
 * 按段落原文实时定位段号。
 *
 * 段号本身不可靠：生成时按服务端抓到的正文算，而 App 的分段常与之不同
 * （分页少抓、换行差异、净化规则删行）。para_hash 记的是段落原文，
 * 这才是稳定锚点 —— 请求方给出正文时，就用它现算段号，不动库里的数据。
 * 这样同一批段评在不同分段的书源下都能落到正确位置。
 */
async function summarizeAligned(
  env: Env,
  bookKey: string,
  chapterKey: string,
  paraData: string,
  paragraphs: string[]
): Promise<{ paraIndex: number; count: number; paraData: string }[]> {
  const rows = await env.DB.prepare(
    // 不用 GROUP_CONCAT：Postgres 没有这个函数（它叫 string_agg），
    // 取明细回来自己归并，两边都能跑
    `SELECT para_index, para_hash, para_text, content FROM reviews
      WHERE book_key = ? AND chapter_key = ? AND reply_to IS NULL`
  )
    .bind(bookKey, chapterKey)
    .all();

  const detail = (rows.results ?? []) as any[];
  if (!detail.length) return [];

  // 按锚点归并：同一段的多条评论共用一个锚点，
  // 拼起来的正文用于判断跨段锚点到底该落在哪一段
  const grouped = new Map<string, { para_index: number; para_text: string; cnt: number; contents: string }>();
  for (const r of detail) {
    const key = `${r.para_index}\u0000${r.para_text ?? ""}`;
    const g = grouped.get(key);
    if (g) {
      g.cnt++;
      if (g.contents.length < 400) g.contents += " " + String(r.content ?? "");
    } else {
      grouped.set(key, {
        para_index: Number(r.para_index),
        para_text: String(r.para_text ?? ""),
        cnt: 1,
        contents: String(r.content ?? ""),
      });
    }
  }
  const stored = [...grouped.values()];

  const idx = buildIndex(paragraphs);

  const merged = new Map<number, number>();
  // 展示段号 → 原始段号，detail 反查时用
  const mapping = new Map<number, number[]>();
  const levels = new Map<string, number>();
  let realigned = 0;
  let dropped = 0;

  // 两趟：先让靠谱的级别把位子占上，模糊级只能在剩下的空位里挑。
  // 否则一段会被两条评论共享，而真正属于它的那条反而被挤掉
  const taken = new Set<number>();
  const pending: { row: any; original: number }[] = [];

  const place = (original: number, hit: { index: number; level: MatchLevel }, cnt: number) => {
    const target = hit.index + 1;
    if (hit.level) levels.set(hit.level, (levels.get(hit.level) ?? 0) + 1);
    if (target !== original) realigned++;
    merged.set(target, (merged.get(target) ?? 0) + cnt);
    const origins = mapping.get(target) ?? [];
    if (!origins.includes(original)) origins.push(original);
    mapping.set(target, origins);
  };

  for (const row of stored) {
    const original = Number(row.para_index);

    // 章节标题（-1）没有对应段落，本来就无需定位
    if (original === -1) {
      merged.set(-1, (merged.get(-1) ?? 0) + Number(row.cnt));
      mapping.set(-1, [-1]);
      continue;
    }

    const anchor = unpackAnchor(row.para_text);
    if (!anchor) {
      dropped++;
      continue;
    }

    // 锚点跨多段时靠评论内容判断归属，所以要把评论一并传进去
    const hit = locate(idx, anchor, taken, String(row.contents ?? ""));
    if (hit.index >= 0 && hit.level !== "fuzzy") {
      taken.add(hit.index);
      place(original, hit, Number(row.cnt));
    } else {
      // 模糊命中的先挣着，等精确级全部落完再重算
      pending.push({ row, original });
    }
  }

  for (const { row, original } of pending) {
    const anchor = unpackAnchor(row.para_text);
    const hit = anchor
      ? locate(idx, anchor, taken, String(row.contents ?? ""))
      : { index: -1, level: null as MatchLevel };

    if (hit.index < 0) {
      // 定位不到就不显示：评论钉在错误的段落上比不显示更糟
      dropped++;
      continue;
    }
    taken.add(hit.index);
    place(original, hit, Number(row.cnt));
  }

  rememberAlignment(`${bookKey}.${chapterKey}`, mapping);

  if (realigned || dropped || levels.size) {
    const names: Record<string, string> = {
      hash: "全文",
      edge: "首尾",
      key: "关键字",
      context: "前后文",
      fuzzy: "模糊",
    };
    const detail = [...levels.entries()].map(([k, v]) => `${names[k] ?? k}${v}`).join(" ");
    console.log(
      `[段评] 锚点定位：命中 ${detail || "0"}，校正 ${realigned} 处` +
        (dropped ? `，${dropped} 处定位失败已隐藏` : "")
    );
  }

  return [...merged.entries()]
    .map(([paraIndex, count]) => ({
      paraIndex,
      count,
      // 每段带上自己的原始段号，detail 直接用它反查，不靠内存
      paraData: packParaData(bookKey, chapterKey, mapping.get(paraIndex)),
    }))
    .filter((r) => r.count > 0 && (r.paraIndex === -1 || r.paraIndex > 0))
    .sort((a, b) => a.paraIndex - b.paraIndex);
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
        hotspots: cfg.hotspots,
        replyDepth: cfg.replyDepth,
      }),
      GENERATE_TIMEOUT_MS
    );

    await persistDrafts(env, task, drafts);
    console.log(
      `[段评] 《${task.bookName}》- ${task.chapterTitle} 生成完成，入库 ${drafts.length} 条主评论`
    );
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
    // 段评绑定的是「章节里的这段文字」而非段号，连同前后文一起存，
    // App 分段与服务端不同时靠它重新定位
    const anchor =
      draft.paraIndex === -1
        ? packAnchor({ target: "", before: "", after: "" })
        : packAnchor(buildAnchor(task.paragraphs, draft.paraIndex - 1));

    // badge 留空：App 里挂个「AI」标签一眼就露馅，来源靠 origin 列区分就够了
    const inserted = await env.DB.prepare(
      `INSERT INTO reviews (book_key, chapter_key, para_index, para_hash, para_text, author, badge, content, origin)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'ai')`
    )
      .bind(
        task.bookKey,
        task.chapterKey,
        draft.paraIndex,
        paraHash,
        anchor,
        draft.author,
        draft.content
      )
      .run();

    const parentId = inserted?.meta?.last_row_id;
    if (!parentId || !draft.replies?.length) continue;

    for (const reply of draft.replies) {
      await env.DB.prepare(
        `INSERT INTO reviews (book_key, chapter_key, para_index, para_hash, para_text, author, badge, content, reply_to, origin)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'ai')`
      )
        .bind(
          task.bookKey,
          task.chapterKey,
          draft.paraIndex,
          paraHash,
          anchor,
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

/** summary 校正过的段号 → 原始段号，供 detail 反查 */
const alignCache = new Map<string, Map<number, number[]>>();
const ALIGN_CACHE_MAX = 64;

function rememberAlignment(chapterCacheKey: string, mapping: Map<number, number[]>): void {
  if (alignCache.size >= ALIGN_CACHE_MAX) {
    const oldest = alignCache.keys().next().value;
    if (oldest !== undefined) alignCache.delete(oldest);
  }
  alignCache.set(chapterCacheKey, mapping);
}

/**
 * 求某个展示段号对应的原始段号。
 * 没有校正记录时原样返回 —— 未经校正的章节，两者本就相同。
 */
async function originParaIndexes(
  bookKey: string,
  chapterKey: string,
  paraIndex: number
): Promise<number[]> {
  const mapped = alignCache.get(`${bookKey}.${chapterKey}`)?.get(paraIndex);
  return mapped?.length ? mapped : [paraIndex];
}

export async function handleReviewDetail(env: Env, url: URL): Promise<Response> {
  const denied = await reviewTokenGuard(env, url);
  if (denied) return denied;

  const locator = unpackParaData(url.searchParams.get("data") ?? "");
  if (!locator) return err("缺少 data 参数");

  const paraIndex = Number(url.searchParams.get("para") ?? "0");
  if (!Number.isInteger(paraIndex)) return err("para 参数非法");

  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const offset = (page - 1) * DETAIL_PAGE_SIZE;

  // summary 报的是校正后的段号，这里得按同一套映射反查回原始段号，
  // 否则点开图标会是空的。paraData 里带了映射就直接用，
  // 它经 App 原样回传，不受进程重启与多副本部署影响
  const origins =
    locator.origins ??
    (await originParaIndexes(locator.bookKey, locator.chapterKey, paraIndex));
  const placeholders = origins.map(() => "?").join(",");

  const rows = await env.DB.prepare(
    `SELECT * FROM reviews
      WHERE book_key = ? AND chapter_key = ? AND para_index IN (${placeholders})
        AND reply_to IS NULL
      ORDER BY id LIMIT ? OFFSET ?`
  )
    .bind(locator.bookKey, locator.chapterKey, ...origins, DETAIL_PAGE_SIZE + 1, offset)
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

/**
 * 组装成 App 认的结构。
 *
 * content 必须是 JSON 字符串，不能是嵌套对象：
 * 规则书源用 $.content 取值时走 safeRuleString，JsonPath 抽出对象后会被
 * toString() 成 Kotlin Map 的 {text=…, time=…} 形式（等号、无引号），
 * ReviewRuleParser.parseContentProtocol 用 GSON 解析必然失败，
 * 于是整串原文被当正文显示。序列化成标准 JSON 字符串才解析得动。
 * JS 书源那条路读的是同一个字符串，parseContentProtocol 一样能处理。
 */
function toDetailItem(row: any, replyCount: number, replyToName?: string) {
  const content: Record<string, unknown> = { text: row.content };
  if (replyToName) content.replyToName = replyToName;
  if (row.created_at) content.time = formatTime(row.created_at);
  if (row.like_count > 0) content.likeCount = Number(row.like_count);
  if (replyCount > 0) content.replyCount = replyCount;

  // 存量数据里 AI 段评的 badge 是写死的 "AI"，直接回给 App 会露馅，这里滤掉
  const badge = row.badge && String(row.badge).trim().toUpperCase() !== "AI"
    ? row.badge
    : undefined;

  return {
    id: String(row.id),
    name: row.author || "书友",
    avatar: row.avatar || undefined,
    badge,
    content: JSON.stringify(content),
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
  // 固定 50 条时前几章就把一页占满，后面的章节被静默截断；改由调用方指定
  const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") || "50")));
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

  // 带上章节标题与序号：整本书的段评混在一起时，光有「第 N 段」无法区分是哪一章
  const [countRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS cnt FROM reviews r ${clause.replace(/book_key/g, "r.book_key").replace(/chapter_key/g, "r.chapter_key")}`)
      .bind(...params)
      .first() as Promise<any>,
    env.DB.prepare(
      `SELECT r.*, c.chapter_title, c.book_url
         FROM reviews r
         LEFT JOIN review_chapters c
           ON c.book_key = r.book_key AND c.chapter_key = r.chapter_key
        ${clause.replace(/book_key/g, "r.book_key").replace(/chapter_key/g, "r.chapter_key")}
        ORDER BY c.id, r.para_index, r.id LIMIT ? OFFSET ?`
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
/** 过期清理默认保留天数；0 表示关闭 */
const DEFAULT_RETAIN_DAYS = 30;

/**
 * 删掉超过保留期的 AI 段评。
 *
 * 只清 origin='ai'：人工批注是自己写的，不该被时间冲掉。
 * 顺带清理不再挂任何评论的章节壳，否则书目里章数只增不减。
 *
 * 日期比较传的是算好的绝对时间：SQLite 的 datetime('now','-N days')
 * 在 Postgres 适配层里不会被改写，只有 datetime('now') 那一种形式会。
 * 传参数化的 "YYYY-MM-DD HH:MM:SS" 两边都认。
 */
export async function purgeExpiredReviews(
  env: Env,
  retainDays: number
): Promise<{ reviews: number; chapters: number }> {
  if (!Number.isFinite(retainDays) || retainDays <= 0) {
    return { reviews: 0, chapters: 0 };
  }

  const cutoff = new Date(Date.now() - retainDays * 86400_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  const removedReviews = await env.DB.prepare(
    `DELETE FROM reviews WHERE origin = 'ai' AND created_at < ?`
  )
    .bind(cutoff)
    .run();

  // 评论清空后留下的章节壳：没有任何评论了才删，
  // 还挂着人工批注的章节要留下
  const removedChapters = await env.DB.prepare(
    `DELETE FROM review_chapters
      WHERE NOT EXISTS (
        SELECT 1 FROM reviews r
         WHERE r.book_key = review_chapters.book_key
           AND r.chapter_key = review_chapters.chapter_key
      )
      AND created_at < ?`
  )
    .bind(cutoff)
    .run();

  const reviews = Number(removedReviews?.meta?.changes ?? 0);
  const chapters = Number(removedChapters?.meta?.changes ?? 0);
  if (reviews || chapters) {
    console.log(
      `[段评] 过期清理：保留 ${retainDays} 天（早于 ${cutoff}），` +
        `删除 ${reviews} 条 AI 段评、${chapters} 个空章节记录`
    );
  }
  return { reviews, chapters };
}

/** 读取配置里的保留天数 */
export async function loadRetainDays(env: Env): Promise<number> {
  const row = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_retain_days'`
  ).first()) as any;
  const raw = row?.value;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return DEFAULT_RETAIN_DAYS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETAIN_DAYS;
  return Math.min(3650, Math.floor(n));
}

export async function handleClearAiReviews(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ bookKey?: string; chapterKey?: string }>(request);
  const bookKey = String(body?.bookKey ?? "").trim();
  if (!bookKey) return err("缺少 bookKey");

  const chapterKey = String(body?.chapterKey ?? "").trim();
  const scope = chapterKey ? "AND chapter_key = ?" : "";
  const params = chapterKey ? [bookKey, chapterKey] : [bookKey];

  await env.DB.prepare(
    `DELETE FROM reviews WHERE book_key = ? ${scope} AND origin = 'ai'`
  )
    .bind(...params)
    .run();

  // 章节记录一并清掉，否则残留一堆空壳：书目里章数不减、
  // 界面上还列着没有任何评论的章节。留下仍有人工批注的那些。
  const removed = await env.DB.prepare(
    `DELETE FROM review_chapters
      WHERE book_key = ? ${scope}
        AND NOT EXISTS (
          SELECT 1 FROM reviews r
           WHERE r.book_key = review_chapters.book_key
             AND r.chapter_key = review_chapters.chapter_key
        )`
  )
    .bind(...params)
    .run();

  // 还有批注的章节只重置状态，让 AI 段评可以重新生成
  await env.DB.prepare(
    `UPDATE review_chapters SET status = 'pending', error = NULL, generated_at = NULL
      WHERE book_key = ? ${scope}`
  )
    .bind(...params)
    .run();

  console.log(
    `[段评] 清空 AI 段评：bookKey=${bookKey.slice(0, 10)}…` +
      (chapterKey ? ` chapterKey=${chapterKey.slice(0, 10)}…` : "（整本）") +
      `，移除 ${removed?.meta?.changes ?? 0} 条空壳章节记录`
  );

  return ok({ removedChapters: removed?.meta?.changes ?? 0 });
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
  const origin = publicOrigin(request);
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

/**
 * 还原对外可访问的地址。
 *
 * 反代通常以明文 HTTP 转发到容器，直接取 new URL(request.url).origin 会得到
 * http://域名:8443 这种协议错配的地址。写进书源后 nginx 回一个
 * 「400 The plain HTTP request was sent to HTTPS port」HTML 页，
 * App 按 JSON 规则解析得到 0 条 —— 请求成功、结果为空、不报错，极难排查。
 * 因此优先采信反代头。
 */
function publicOrigin(request: Request): string {
  const url = new URL(request.url);

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || url.host;

  let proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (!proto) {
    // Forwarded: proto=https;host=...
    const fwd = request.headers.get("forwarded");
    proto = fwd?.match(/proto=([^;,\s]+)/i)?.[1];
  }
  if (!proto && request.headers.get("x-forwarded-ssl") === "on") proto = "https";
  if (!proto) proto = url.protocol.replace(":", "");

  return `${proto}://${host}`;
}

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
    // 章节标题必须走 java.get("title")，写 chapter.title 会直接抛异常。
    // bookUrl 与 origin 供服务端借 reader 反查正文，从而自动生成 AI 段评。
    reviewSummaryUrl:
      `${origin}/review/summary?book={{encodeURIComponent(book.name)}}` +
      `&author={{encodeURIComponent(book.author)}}` +
      `&chapter={{encodeURIComponent(java.get("title"))}}` +
      `&bookUrl={{encodeURIComponent(book.bookUrl)}}` +
      `&origin={{encodeURIComponent(book.origin)}}` +
      // baseUrl 即 chapter.url，服务端据此直接抓源站取正文，
      // 与 App 走同一条解析路径，段号才对得上
      `&chapterUrl={{encodeURIComponent(baseUrl)}}${t}`,
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

  const origin = publicOrigin(request);
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

// ─── 诊断 ─────────────────────────────────────────────────────────

type DiagStatus = "ok" | "fail" | "skip";

interface DiagStep {
  name: string;
  status: DiagStatus;
  /** 兼容旧字段：skip 也算通过 */
  ok: boolean;
  detail: string;
}

/**
 * 同步跑一遍整条链路并逐步汇报，用来定位「段评不出现」卡在哪里。
 * 与真实请求不同，这里不做 fire-and-forget，也会跳过章节状态锁。
 */
export async function handleDiagnoseReview(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{
    bookName?: string;
    author?: string;
    chapterTitle?: string;
    bookUrl?: string;
    origin?: string;
    generate?: boolean;
  }>(request);

  const bookName = String(body?.bookName ?? "").trim();
  const chapterTitle = String(body?.chapterTitle ?? "").trim();
  const author = String(body?.author ?? "").trim();
  let bookUrl = String(body?.bookUrl ?? "").trim();
  let originUrl = String(body?.origin ?? "").trim();

  if (!bookName || !chapterTitle) return err("书名和章节标题不能为空");

  const tag = `《${bookName}》${author ? `(${author})` : ""} - ${chapterTitle}`;
  console.log(`[段评诊断] ===== 开始诊断 ${tag} =====`);

  const steps: DiagStep[] = [];
  const push = (name: string, status: DiagStatus, detail: string) => {
    steps.push({ name, status, ok: status !== "fail", detail });
    console.log(`[段评诊断] ${status.toUpperCase().padEnd(4)} ${tag} | ${name}: ${detail}`);
  };

  const bookKey = await bookKeyOf(bookName, author);
  const chapterKey = await chapterKeyOf(chapterTitle);
  push("定位键计算", "ok", `bookKey=${bookKey.slice(0, 12)}… chapterKey=${chapterKey.slice(0, 12)}…`);

  const existing = await summarize(env, bookKey, chapterKey, packParaData(bookKey, chapterKey));
  push(
    "库中已有段评",
    "ok",
    existing.length
      ? `${existing.length} 个段落有评论：${existing.map((e) => `第${e.paraIndex}段×${e.count}`).join("、")}`
      : "无——App 端因此不会显示任何图标"
  );

  const chapterRow = (await env.DB.prepare(
    `SELECT status, error, para_count FROM review_chapters WHERE book_key = ? AND chapter_key = ?`
  )
    .bind(bookKey, chapterKey)
    .first()) as any;
  push(
    "章节生成状态",
    chapterRow?.status === "failed" ? "fail" : "ok",
    chapterRow
      ? `status=${chapterRow.status}${chapterRow.error ? ` error=${chapterRow.error}` : ""}${
          chapterRow.status !== "pending" ? "（非 pending 会跳过生成，需先清空重置）" : ""
        }`
      : "尚无记录（首次访问会新建）"
  );

  const tokenRow = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_token'`
  ).first()) as any;
  const token = String(tokenRow?.value ?? "").trim();
  push("访问令牌", "ok", token ? `已配置，注入的 URL 必须带 token=${token.slice(0, 4)}…` : "未配置，/review/* 对外开放");

  // 写进书源的地址必须自己能通。协议错配时 nginx 会回 400 HTML，
  // App 按 JSON 规则解析得到 0 条，全程不报错，是最难查的一类故障
  const selfOrigin = publicOrigin(request);
  try {
    const probe = `${selfOrigin}/review/summary?book=${encodeURIComponent(bookName)}` +
      `&chapter=${encodeURIComponent(chapterTitle)}` +
      (token ? `&token=${encodeURIComponent(token)}` : "");
    const res = await fetch(probe, { signal: AbortSignal.timeout(10_000) });
    const type = res.headers.get("content-type") ?? "";
    const isJson = type.includes("json");
    push(
      "对外地址自检",
      res.ok && isJson ? "ok" : "fail",
      res.ok && isJson
        ? `${selfOrigin} 可达且返回 JSON`
        : `${selfOrigin} 返回 HTTP ${res.status} ${type}——书源拿不到 JSON。` +
          (res.status === 400 && !isJson
            ? "多半是协议错配（把 http 请求发给了 HTTPS 端口），重新注入一次即可写入正确协议"
            : "请检查反代配置")
    );
  } catch (e) {
    push(
      "对外地址自检",
      "fail",
      `${selfOrigin} 不可达：${(e as Error).message}——书源里写的就是这个地址`
    );
  }

  const aiCfg = await loadAiConfig(env);
  push(
    "模型配置",
    aiCfg.apiKey ? "ok" : "fail",
    aiCfg.apiKey
      ? `${detectProvider(aiCfg)} / ${aiCfg.model}，每章 ${aiCfg.density} 条`
      : "未配置 API Key —— 不会生成任何 AI 段评"
  );
  if (aiCfg.apiKey) {
    // base URL 填错是最常见的坑，把最终地址摆出来让人一眼核对
    push(
      "模型请求地址",
      "ok",
      describeEndpoint(aiCfg) +
        (detectProvider(aiCfg) === "openai-compatible"
          ? "（按 /v1 结尾判定为 OpenAI 兼容端点）"
          : "（原生 Gemini 端点）")
    );
  }

  if (!bookUrl || !originUrl) {
    const found = await resolveBookLocation(env, { bookKey, chapterKey, bookName, author });
    if (found.bookUrl && found.originUrl) {
      bookUrl = found.bookUrl;
      originUrl = found.originUrl;
      push("反查书籍链接", "ok", `取自${found.from}：${bookUrl}`);
    } else {
      push(
        "反查书籍链接",
        "skip",
        (found.failReason ?? "库里还没有这本书的 bookUrl，reader 书架上也没找到") +
          "。可在下方从 reader 书架点选，或让 App 用新注入的书源打开一次本章自动记下"
      );
      return ok({ steps, canGenerate: false });
    }
  }

  const readerCfg = await resolveReaderConfig(env);
  if (!readerCfg) {
    push("reader 配置", "fail", "自动抓取已关闭，或 reader 地址为空（未配 reader_url 且无 READER_URL）");
    return ok({ steps, canGenerate: false });
  }
  push("reader 配置", "ok", readerCfg.readerUrl + (readerCfg.accessToken ? "（带 accessToken）" : ""));

  const bookSource = await findBookSource(env, originUrl);
  if (!bookSource) {
    push("查找书源", "fail", `订阅库里没有 book_source_url = ${originUrl} 的记录`);
    return ok({ steps, canGenerate: false });
  }
  push("查找书源", "ok", `${bookSource.bookSourceName ?? "(无名)"} → ${originUrl}`);

  let toc: any[];
  try {
    toc = await loadToc(env, readerCfg.readerUrl, bookUrl, bookSource, readerCfg.accessToken);
    push("抓取目录", "ok", `共 ${toc.length} 章，例：${toc.slice(0, 3).map((c) => c?.title).join(" / ")}`);
  } catch (e) {
    push("抓取目录", "fail", (e as Error).message);
    return ok({ steps, canGenerate: false });
  }

  const matched = matchChapter(toc, chapterTitle);
  if (!matched) {
    const wantNum = extractChapterNumber(chapterTitle);
    // 序号能解析出来的话，把目录里那个位置的标题摆出来供人工核对
    const nearby =
      wantNum !== null && wantNum >= 1 && wantNum <= toc.length
        ? `。目录第 ${wantNum} 项是「${toc[wantNum - 1]?.title}」——若这就是你要的章节，说明两边编号方式不同`
        : "";
    push(
      "定位章节",
      "fail",
      `目录里找不到「${chapterTitle}」${nearby}。目录标题样例：${toc
        .slice(0, 5)
        .map((c) => c?.title)
        .join(" / ")}`
    );
    return ok({ steps, canGenerate: false });
  }
  const index = matched.index;
  push("定位章节", "ok", `${matched.how} → index=${index}，目录标题「${toc[index]?.title}」`);

  let paragraphs: string[];
  try {
    const content = await readerPost(
      readerCfg.readerUrl,
      "/getBookContent",
      { url: bookUrl, index, bookSource },
      readerCfg.accessToken
    );
    const text = typeof content === "string" ? content : String(content ?? "");
    paragraphs = splitParagraphs(text, String(toc[index]?.title ?? chapterTitle));
    if (!paragraphs.length) {
      push("抓取正文", "fail", "正文为空或分段后无内容");
      return ok({ steps, canGenerate: false });
    }
    push(
      "抓取正文",
      "ok",
      `${paragraphs.length} 段，首段：${paragraphs[0].slice(0, 40)}…`
    );
  } catch (e) {
    push("抓取正文", "fail", (e as Error).message);
    return ok({ steps, canGenerate: false });
  }

  if (!aiCfg.apiKey) {
    push("调用模型", "skip", "未配置 API Key，跳过");
    return ok({ steps, canGenerate: false });
  }

  if (body?.generate === false) {
    push("调用模型", "skip", "已跳过（诊断模式未要求生成）");
    return ok({ steps, canGenerate: true });
  }

  try {
    const drafts = await createGenerator(aiCfg).generate({
      bookName,
      author,
      chapterTitle,
      paragraphs,
      density: aiCfg.density,
      personas: aiCfg.personas,
      hotspots: aiCfg.hotspots,
      replyDepth: aiCfg.replyDepth,
    });
    push("调用模型", drafts.length > 0 ? "ok" : "fail", `返回 ${drafts.length} 条有效评论`);

    if (drafts.length) {
      await env.DB.prepare(
        `INSERT INTO review_chapters (book_key, chapter_key, book_name, author, chapter_title, para_count, status)
         VALUES (?, ?, ?, ?, ?, ?, 'generating')
         ON CONFLICT(book_key, chapter_key) DO UPDATE SET status = 'generating'`
      )
        .bind(bookKey, chapterKey, bookName, author, chapterTitle, paragraphs.length)
        .run();

      await persistDrafts(
        env,
        { bookKey, chapterKey, bookName, author, chapterTitle, paragraphs, force: true },
        drafts
      );
      await env.DB.prepare(
        `UPDATE review_chapters SET status = 'done', error = NULL, generated_at = datetime('now')
          WHERE book_key = ? AND chapter_key = ?`
      )
        .bind(bookKey, chapterKey)
        .run();

      const after = await summarize(env, bookKey, chapterKey, packParaData(bookKey, chapterKey));
      push("写入数据库", "ok", `现有 ${after.length} 个段落带评论，回 App 重进本章即可看到图标`);
    }
  } catch (e) {
    push("调用模型", "fail", (e as Error).message);
    return ok({ steps, canGenerate: false });
  }

  return ok({ steps, canGenerate: true });
}

/** 返回段评相关配置，供管理界面展示 */
export async function handleGetReviewConfig(env: Env): Promise<Response> {
  const cfg = await loadAiConfig(env);

  // 把容器实际跑的版本回给界面：段评功能迭代快，
  // 「改了没生效」十次有九次是镜像还没换
  let version = "";
  try {
    version = (await fs.readFile(path.join(process.cwd(), "VERSION"), "utf-8")).trim();
  } catch {
    version = "unknown";
  }

  const readerCfg = await resolveReaderConfig(env);
  const readerRow = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'reader_url'`
  ).first()) as any;
  const prefetchRow = (await env.DB.prepare(
    `SELECT value FROM system_config WHERE key = 'review_prefetch'`
  ).first()) as any;
  const retainDays = await loadRetainDays(env);
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
    hotspots: cfg.hotspots,
    replyDepth: cfg.replyDepth,
    prefetch: Number(prefetchRow?.value ?? "2"),
    retainDays,
    personas: cfg.personas,
    defaultPersonas: DEFAULT_PERSONAS,
    version,
    autoFetch: !!readerCfg,
    readerAuth: readerCfg?.accessToken
      ? (readerCfg.username ? `已登录（${readerCfg.username}）` : "使用固定 accessToken")
      : "未认证",
    readerUrl: String(readerRow?.value ?? ""),
    effectiveReaderUrl: readerCfg?.readerUrl ?? "",
    stats: {
      aiCount: Number(stats?.ai_count ?? 0),
      humanCount: Number(stats?.human_count ?? 0),
      chapterCount: Number(stats?.chapter_count ?? 0),
      failedCount: Number(stats?.failed_count ?? 0),
    },
  });
}
