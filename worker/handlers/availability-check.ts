/** 书源检测：优先运行 reader 原规则；无 reader 时仅验证明确支持的静态规则。 */
import { checkWithReader } from './source-reader-check.ts';
import { extractSearchBooks } from './source-rules.ts';
import { readSourceBody } from './source-http.ts';

export type CheckVerdict = "available" | "unavailable" | "skipped";

export interface CheckOutcome {
  verdict: CheckVerdict;
  /** 机器可读的判定原因短码，用于日志聚合与问题定位 */
  reason: string;
  /** 补充信息（错误码、命中的特征等） */
  detail?: string;
  httpStatus?: number;
}

export interface CheckOptions {
  /** 单次请求超时，默认 12000ms */
  timeoutMs?: number;
  /** 网络抖动类错误的重试次数，默认 1 */
  retries?: number;
  keyword?: string;
  depth?: 'search' | 'content';
  totalTimeoutMs?: number;
  reader?: { url: string; accessToken?: string };
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_KEYWORD = "我的";
const DEFAULT_TIMEOUT_MS = 12000;
/** 特征匹配用不到整页，读够 1MB 就够判定，避免大响应吃满内存 */
const MAX_BODY_BYTES = 1024 * 1024;


const available = (reason: string, httpStatus?: number, detail?: string): CheckOutcome =>
  ({ verdict: "available", reason, httpStatus, detail });
const unavailable = (reason: string, httpStatus?: number, detail?: string): CheckOutcome =>
  ({ verdict: "unavailable", reason, httpStatus, detail });
const skipped = (reason: string, detail?: string): CheckOutcome =>
  ({ verdict: "skipped", reason, detail });

// ─────────────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────────────

export async function checkBookSource(
  rawJsonStr: string,
  bookSourceUrl: string,
  options: CheckOptions = {}
): Promise<CheckOutcome> {
  let src: any;
  try {
    src = JSON.parse(rawJsonStr);
  } catch (e: any) {
    return unavailable("invalid-json", undefined, e?.message);
  }
  if (!src || typeof src !== "object" || Array.isArray(src)) {
    return unavailable("invalid-json", undefined, "书源不是 JSON 对象");
  }

  if (typeof src.loginUrl === 'string' && src.loginUrl.trim()) return unavailable('login-required', undefined, '书源带登录配置，按设置禁用');
  if (options.reader) return checkWithReader(src, options);
  const searchUrl: unknown = src.searchUrl;

  // 含 JS 的规则在本地无法求值，判不了
  if (hasDynamicScript(searchUrl) || hasDynamicScript(bookSourceUrl) || hasDynamicScript(src.header)) {
    return skipped("dynamic-js", "searchUrl 或源地址含 JS/动态模板");
  }

  // 没有搜索规则的源只能退一步验证域名是否存活
  if (typeof searchUrl !== "string" || !searchUrl.trim() || searchUrl.trim() === '-') {
    return skipped('no-search-rule', '未配置可执行的搜索规则，需要 reader 检测');
  }

  let req: SearchRequest;
  try {
    req = buildSearchRequest(src, searchUrl, bookSourceUrl, options.keyword);
    if (req.keywordEncodingUnsupported) return skipped("charset-unsupported", "非 UTF-8 请求请配置 reader 完整检测");
  } catch (e: any) {
    return unavailable("invalid-url", undefined, e?.message);
  }

  const fetched = await fetchWithRetry(req, options);
  if ("outcome" in fetched) return fetched.outcome;
  const { res, bytes } = fetched;

  const text = decodeBody(bytes, req.charset, res.headers.get("content-type"));

  // 拦截页判定要先于状态码：Cloudflare 挑战页本身就是 503，
  // 先看状态码只会得到笼统的 server-error，丢掉「被反爬拦下」这个真实原因
  const blockOutcome = detectBlockPage(text, res.status);
  if (blockOutcome) return blockOutcome;

  const statusOutcome = classifyStatus(res.status);
  if (statusOutcome) return statusOutcome;

  const redirectOutcome = classifyRedirect(res);
  if (redirectOutcome) return redirectOutcome;

  const result = await classifyContent(src, text, res, req);
  return options.depth === 'content' && result.verdict === 'available'
    ? skipped('reader-required', '静态搜索已验证，正文检测需要 reader') : result;
}

/**
 * 兼容旧调用方的二值封装。
 * 仅明确验证通过时返回 true —— 需要区分三态的调用方请直接用 checkBookSource。
 */
export async function checkBookSourceRealAvailability(
  rawJsonStr: string,
  bookSourceUrl: string
): Promise<boolean> {
  const outcome = await checkBookSource(rawJsonStr, bookSourceUrl);
  return outcome.verdict === "available";
}

/**
 * 是否含本地无法求值的内容。
 * `<js>…</js>` 和 `@js:` 是显式 JS；`{{…}}` 里除了标准占位符，其余都是 JS 表达式
 * （常见如 `{{java.timeFormat(...)}}`、`{{page*20}}`）。
 */
function hasDynamicScript(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/<js>|@js:/i.test(value)) return true;
  for (const m of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (!/^(?:key|searchKey|page|searchPage|index)$/.test(m[1].trim())) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// 请求构造
// ─────────────────────────────────────────────────────────────────────

interface SearchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  charset: string | null;
  keyword: string;
  /** 关键字按非 UTF-8 编码发送时无法正确构造，命中的话结果不能作为失效依据 */
  keywordEncodingUnsupported: boolean;
}

function buildSearchRequest(src: any, searchUrl: string, bookSourceUrl: string, checkKeyword?: string): SearchRequest {
  const keyword = checkKeyword || resolveKeyword(src);
  const split = splitUrlAndOptions(searchUrl.trim());
  const opts = split.options ? parseLooseJson(split.options) : null;
  if (split.options && !opts) throw new Error("无法解析请求选项");

  const method = String(opts?.method || "GET").toUpperCase();
  const charset = normalizeCharset(opts?.charset);
  // TextEncoder 只产出 UTF-8，GBK 之类的站点无法正确编码关键字
  const keywordEncodingUnsupported = charset !== null && charset !== "utf-8";

  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  };
  mergeHeaders(headers, src.header);
  mergeHeaders(headers, opts?.headers);

  const url = resolveUrl(fillPlaceholders(split.url, keyword, true), bookSourceUrl);
  for (const key of Object.keys(headers)) {
    headers[key] = fillPlaceholders(headers[key], keyword, false);
  }

  let body: string | undefined;
  if (opts?.body !== undefined && opts.body !== null && method !== "GET" && method !== "HEAD") {
    body = buildBody(opts.body, keyword, headers);
  }

  return { url, method, headers, body, charset, keyword, keywordEncodingUnsupported };
}

function resolveKeyword(src: any): string {
  const candidates = [src?.ruleSearch?.checkKeyWord, src?.checkKeyWord];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return DEFAULT_KEYWORD;
}

/**
 * 拆出 searchUrl 尾部的 `,{...}` 请求选项。
 * 从右侧匹配，避免 query string 里的 `,{` 被当成选项起点。
 */
function splitUrlAndOptions(raw: string): { url: string; options: string | null } {
  const match = raw.match(/,\s*(\{[\s\S]*\})\s*$/);
  if (!match || match.index === undefined) return { url: raw, options: null };
  return { url: raw.slice(0, match.index).trim(), options: match[1] };
}

/**
 * 解析请求选项。书源里的选项常是手写的宽松 JS 对象字面量，
 * 修几种常见写法后再 parse —— 绝不用 Function/eval，书源内容来自订阅源，不可信。
 */
function parseLooseJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const repaired = raw
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":') // 裸键名补引号
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, s) => JSON.stringify(s.replace(/\\'/g, "'"))) // 单引号字符串
    .replace(/,\s*([}\]])/g, "$1"); // 尾随逗号
  try {
    return JSON.parse(repaired);
  } catch (_) {}
  return null;
}

function mergeHeaders(target: Record<string, string>, raw: unknown): void {
  if (!raw) return;
  let parsed: any = raw;
  if (typeof raw === "string") {
    parsed = parseLooseJson(raw);
  }
  if (!parsed || typeof parsed !== "object") return;
  for (const [k, v] of Object.entries(parsed)) {
    if (v === null || v === undefined || typeof v === "object") continue;
    for (const existing of Object.keys(target)) if (existing.toLowerCase() === k.toLowerCase()) delete target[existing];
    target[k] = String(v);
  }
}

/** 只替换本地可求值的占位符，其余形式已在 hasDynamicScript 处被判为无法判定 */
function fillPlaceholders(str: string, keyword: string, encode: boolean): string {
  const key = encode ? encodeURIComponent(keyword) : keyword;
  return str
    .replace(/\{\{\s*(?:key|searchKey)\s*\}\}/g, key)
    .replace(/\{\{\s*(?:page|searchPage|index)\s*\}\}/g, "1");
}

function resolveUrl(urlStr: string, bookSourceUrl: string): string {
  let resolved = urlStr;
  if (!/^https?:\/\//i.test(resolved)) {
    resolved = new URL(resolved, bookSourceUrl).toString();
  }
  if (!/^https?:\/\//i.test(resolved)) {
    throw new Error(`非 HTTP(S) 地址: ${resolved}`);
  }
  return resolved;
}

function buildBody(rawBody: unknown, keyword: string, headers: Record<string, string>): string {
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");

  if (typeof rawBody === "object") {
    if (!hasContentType) headers["Content-Type"] = "application/json";
    const fill = (v: any): any => typeof v === 'string' ? fillPlaceholders(v, keyword, false)
      : Array.isArray(v) ? v.map(fill) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, value]) => [k, fill(value)])) : v;
    return JSON.stringify(fill(rawBody));
  }

  const body = String(rawBody).trim();
  const isForm = body.includes("=") && !body.startsWith("{") && !body.startsWith("[");
  if (!isForm) {
    return fillPlaceholders(body, keyword, false);
  }

  if (!hasContentType) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const params = new URLSearchParams(body);
  const filled = new URLSearchParams();
  for (const [key, value] of params) filled.append(key, fillPlaceholders(value, keyword, false));
  return filled.toString();
}

// ─────────────────────────────────────────────────────────────────────
// 网络请求
// ─────────────────────────────────────────────────────────────────────

type FetchSuccess = { res: Response; bytes: Uint8Array };
type FetchFailure = { outcome: CheckOutcome };

async function fetchWithRetry(
  req: SearchRequest,
  options: CheckOptions
): Promise<FetchSuccess | FetchFailure> {
  const retries = options.retries ?? 1;
  let last: CheckOutcome | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fetchOnce(req, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (!("outcome" in result)) return result;
    last = result.outcome;
    // 只重试抖动类错误：超时、连接被重置。DNS / 证书 / 拒绝连接重试也是同样结果
    if (last.reason !== "timeout" && last.reason !== "connection-reset") break;
  }
  return { outcome: last! };
}

async function fetchOnce(
  req: SearchRequest,
  timeoutMs: number
): Promise<FetchSuccess | FetchFailure> {
  const controller = new AbortController();
  // 手动控制而非 AbortSignal.timeout，让超时同时覆盖响应体读取
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "follow",
      signal: controller.signal,
    });
    const { bytes, truncated } = await readSourceBody(res, MAX_BODY_BYTES);
    if (truncated) return { outcome: skipped('body-too-large', '响应超过读取上限，请使用 reader 复检') };
    return { res, bytes };
  } catch (e: any) {
    return { outcome: classifyNetworkError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 网络层错误分类。undici 把系统错误码放在 cause 上 */
function classifyNetworkError(e: any): CheckOutcome {
  const code = String(e?.code || e?.cause?.code || "");
  const name = String(e?.name || "");
  const message = String(e?.message || e);
  const detail = code || message;

  if (name === "AbortError" || name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return skipped("timeout", "网络请求超时，请稍后复检");
  }
  if (code === "EAI_AGAIN") return skipped("dns-temporary", "DNS 暂时不可用");
  if (code === "ENOTFOUND" || code === "ERR_INVALID_URL") {
    return unavailable("dns-failure", undefined, detail);
  }
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return unavailable("connection-refused", undefined, detail);
  }
  if (code === "ECONNRESET" || code === "EPIPE" || message.includes("socket hang up")) {
    return skipped("connection-reset", "连接中断，请稍后复检");
  }
  // 证书过期/自签名的站点在阅读 App 里同样打不开，算失效，但不当异常上报
  if (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || /CERT|SSL|TLS/i.test(code)) {
    return skipped("tls-failure", "检测环境 TLS 验证失败，请复检");
  }
  return skipped("network-error", "检测网络异常，请稍后复检");
}

// ─────────────────────────────────────────────────────────────────────
// 响应判定
// ─────────────────────────────────────────────────────────────────────

function classifyStatus(status: number): CheckOutcome | null {
  if (status >= 200 && status < 400) return null;
  // 限流只说明测得太密，不代表源失效
  if (status === 429) return skipped("rate-limited", `HTTP ${status}`);
  if (status === 401) return unavailable("login-required", status, "书源要求登录，按设置禁用");
  if (status === 403) return skipped("access-denied", "访问被拒绝，需确认是否存在防护限制");
  if (status >= 500) return skipped("server-error", `源站暂时错误 HTTP ${status}`);
  return unavailable("http-error", status);
}

const AUTH_PATH_SEGMENTS = new Set([
  "login", "signin", "sign-in", "register", "signup", "sign-up", "auth", "oauth", "sso",
]);

/** 跳到登录/注册页说明搜索要鉴权。按路径段精确匹配 —— 子串匹配会把 /authors/ 之类误杀 */
function classifyRedirect(res: Response): CheckOutcome | null {
  if (!res.redirected || !res.url) return null;
  try {
    const segments = new URL(res.url).pathname.toLowerCase().split("/").filter(Boolean);
    for (const seg of segments) {
      const name = seg.replace(/\.(html?|php|aspx?|jsp)$/, "");
      if (AUTH_PATH_SEGMENTS.has(name)) {
        return unavailable("login-redirect", res.status, res.url);
      }
    }
  } catch (_) {}
  return null;
}

async function classifyContent(
  src: any,
  text: string,
  res: Response,
  req: SearchRequest
): Promise<CheckOutcome> {
  if (!text.trim()) return skipped("empty-body", "返回空内容，请复检");
  const result = await extractSearchBooks(text, res.headers.get('content-type') || '', src.ruleSearch, res.url || req.url);
  if (!result.supported) return skipped('rule-unsupported', '静态规则无法完整解释，请配置 reader 检测');
  if (result.books.length) return available('search-verified', res.status, `实际解析出 ${result.books.length} 个书名及书籍地址，正文未测`);
  if (!result.matched) return skipped('empty-result', '测试关键词没有匹配结果，请复检');
  return unavailable('search-fields-empty', res.status, '搜索列表存在，但无法解析有效书名和书籍地址');
}

/** 强特征单独成立即可判定，弱特征需要配合 4xx/5xx 状态码，避免误杀正常页面 */
const HARD_BLOCK_PATTERNS = [
  "cf-browser-verification",
  "__cf_chl_",
  "/cdn-cgi/challenge-platform",
  "challenge-form",
  "aliyun-waf",
  "tencent-waf",
];
const SOFT_BLOCK_PATTERNS = [
  "captcha",
  "验证码",
  "滑块验证",
  "安全验证",
  "verify you are human",
  "checking your browser",
];
const BLOCK_TITLE_PATTERNS = [
  "just a moment",
  "attention required",
  "access denied",
  "安全验证",
  "人机验证",
  "请完成验证",
  "访问被拒绝",
];
const LOGIN_TITLE_PATTERNS = ["登录", "login", "sign in", "会员登录"];
const LOGIN_WALL_PATTERNS = ["请先登录", "请登录后", "需要登录后", "登录后查看", "登录后阅读"];

function detectBlockPage(text: string, status: number): CheckOutcome | null {
  const lower = text.toLowerCase();
  const title = (text.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1] || "")
    .toLowerCase()
    .trim();

  for (const p of HARD_BLOCK_PATTERNS) {
    if (lower.includes(p)) return skipped("anti-bot", p);
  }
  for (const p of BLOCK_TITLE_PATTERNS) {
    if (title.includes(p)) return skipped("anti-bot", `title: ${p}`);
  }
  if (status >= 400) {
    for (const p of SOFT_BLOCK_PATTERNS) {
      if (lower.includes(p)) return skipped("anti-bot", p);
    }
  }

  // 登录墙：标题是登录页，或短页面里出现明确的登录提示。
  // 不做全文子串匹配 —— 小说站页头几乎都有「登录」入口。
  for (const p of LOGIN_TITLE_PATTERNS) {
    if (title.includes(p)) return unavailable("login-required", status, `title: ${p}`);
  }
  if (text.length < 3000) {
    for (const p of LOGIN_WALL_PATTERNS) {
      if (text.includes(p)) return unavailable("login-required", status, p);
    }
  }
  return null;
}

function normalizeCharset(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const cs = raw.trim().toLowerCase();
  return cs === "utf8" ? "utf-8" : cs;
}

/** 按 charset 解码。GBK 站点用 UTF-8 解出来是乱码，会让特征匹配全部失手 */
function decodeBody(bytes: Uint8Array, charset: string | null, contentType: string | null): string {
  const candidates = [
    charset,
    normalizeCharset(contentType?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1]),
    sniffMetaCharset(bytes),
    "utf-8",
  ];
  for (const cs of candidates) {
    if (!cs) continue;
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch (_) {
      // 不认识的编码标签，试下一个
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** 从 HTML 头部的 meta 标签里嗅探编码；latin1 解码只为定位标签，不参与内容判定 */
function sniffMetaCharset(bytes: Uint8Array): string | null {
  try {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    return normalizeCharset(head.match(/charset\s*=\s*["']?\s*([\w-]+)/i)?.[1]);
  } catch (_) {
    return null;
  }
}
