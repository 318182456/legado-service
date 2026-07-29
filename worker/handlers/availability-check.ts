/**
 * 书源可用性判定
 *
 * 模拟阅读 App 的书源校验流程：按 searchUrl 的配置发起一次真实搜索请求，
 * 再用 ruleSearch.bookList 检查响应里是否真的存在搜索结果。
 *
 * 判定是三态的 —— 除了「可用」「失效」，还有「无法判定」。本地环境跑不了
 * 书源里的 JS 规则，也无法区分站点限流和站点失效，这类源如果被强行归入
 * 二值结果，要么虚高标记为正常，要么误杀。调用方不应据 skipped 改写
 * is_available，只更新 last_checked 即可。
 *
 * 本模块被工作线程直接加载，因此不依赖任何项目内其它模块与 Node 内置模块。
 */

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
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_KEYWORD = "我的";
const DEFAULT_TIMEOUT_MS = 12000;
/** 特征匹配用不到整页，读够 1MB 就够判定，避免大响应吃满内存 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 正常搜索页面（HTML 或 JSON）都不会短于这个长度 */
const MIN_BODY_LENGTH = 200;

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
  if (!src || typeof src !== "object") {
    return unavailable("invalid-json", undefined, "书源不是 JSON 对象");
  }

  const searchUrl: unknown = src.searchUrl;

  // 含 JS 的规则在本地无法求值，判不了
  if (hasDynamicScript(searchUrl) || hasDynamicScript(bookSourceUrl)) {
    return skipped("dynamic-js", "searchUrl 或源地址含 JS/动态模板");
  }

  // 没有搜索规则的源只能退一步验证域名是否存活
  if (typeof searchUrl !== "string" || !searchUrl.trim()) {
    return await checkHomepage(bookSourceUrl, options);
  }

  let req: SearchRequest;
  try {
    req = buildSearchRequest(src, searchUrl, bookSourceUrl);
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

  return classifyContent(src, text, res, req);
}

/**
 * 兼容旧调用方的二值封装。
 * 「无法判定」按可用处理以避免误杀 —— 需要区分三态的调用方请直接用 checkBookSource。
 */
export async function checkBookSourceRealAvailability(
  rawJsonStr: string,
  bookSourceUrl: string
): Promise<boolean> {
  const outcome = await checkBookSource(rawJsonStr, bookSourceUrl);
  return outcome.verdict !== "unavailable";
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

function buildSearchRequest(src: any, searchUrl: string, bookSourceUrl: string): SearchRequest {
  const keyword = resolveKeyword(src);
  const split = splitUrlAndOptions(searchUrl.trim());
  const opts = split.options ? parseLooseJson(split.options) : null;

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
    return fillPlaceholders(JSON.stringify(rawBody), keyword, false);
  }

  const body = String(rawBody).trim();
  const isForm = body.includes("=") && !body.startsWith("{") && !body.startsWith("[");
  if (!isForm) {
    return fillPlaceholders(body, keyword, false);
  }

  if (!hasContentType) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return body
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      const value = fillPlaceholders(pair.slice(eq + 1), keyword, false);
      return `${name}=${encodeURIComponent(value)}`;
    })
    .join("&");
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
    const bytes = await readBodyCapped(res, MAX_BODY_BYTES);
    return { res, bytes };
  } catch (e: any) {
    return { outcome: classifyNetworkError(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const slice = chunk.subarray(0, out.length - offset);
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

/** 网络层错误分类。undici 把系统错误码放在 cause 上 */
function classifyNetworkError(e: any): CheckOutcome {
  const code = String(e?.code || e?.cause?.code || "");
  const name = String(e?.name || "");
  const message = String(e?.message || e);
  const detail = code || message;

  if (name === "AbortError" || name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return unavailable("timeout", undefined, detail);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ERR_INVALID_URL") {
    return unavailable("dns-failure", undefined, detail);
  }
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return unavailable("connection-refused", undefined, detail);
  }
  if (code === "ECONNRESET" || code === "EPIPE" || message.includes("socket hang up")) {
    return unavailable("connection-reset", undefined, detail);
  }
  // 证书过期/自签名的站点在阅读 App 里同样打不开，算失效，但不当异常上报
  if (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || /CERT|SSL|TLS/i.test(code)) {
    return unavailable("tls-failure", undefined, detail);
  }
  return unavailable("network-error", undefined, detail);
}

// ─────────────────────────────────────────────────────────────────────
// 响应判定
// ─────────────────────────────────────────────────────────────────────

function classifyStatus(status: number): CheckOutcome | null {
  if (status >= 200 && status < 400) return null;
  // 限流只说明测得太密，不代表源失效
  if (status === 429) return skipped("rate-limited", `HTTP ${status}`);
  if (status === 401 || status === 403) return unavailable("access-denied", status);
  if (status >= 500) return unavailable("server-error", status);
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

function classifyContent(
  src: any,
  text: string,
  res: Response,
  req: SearchRequest
): CheckOutcome {
  if (!text.trim()) return unavailable("empty-body", res.status);
  if (text.length < MIN_BODY_LENGTH) {
    return unavailable("body-too-short", res.status, `${text.length} 字符`);
  }

  const listRule = typeof src?.ruleSearch?.bookList === "string" ? src.ruleSearch.bookList.trim() : "";
  const contentType = res.headers.get("content-type") || "";
  const trimmed = text.trim();
  const looksJson =
    contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");

  const outcome = looksJson
    ? classifyJsonContent(trimmed, listRule, res.status)
    : classifyHtmlContent(text, listRule, res.status);

  // 关键字没能按站点编码发出去时，搜不到结果是我们自己的问题，不能算源失效
  if (
    outcome.verdict === "unavailable" &&
    req.keywordEncodingUnsupported &&
    (outcome.reason === "empty-result" || outcome.reason === "rule-miss")
  ) {
    return skipped("charset-unsupported", `${req.charset} 关键字编码不支持`);
  }
  return outcome;
}

/** 强特征单独成立即可判定，弱特征需要配合 4xx/5xx 状态码，避免误杀正常页面 */
const HARD_BLOCK_PATTERNS = [
  "cf-browser-verification",
  "__cf_chl_",
  "/cdn-cgi/challenge-platform",
  "challenge-form",
  "g-recaptcha",
  "h-captcha",
  "data-sitekey",
  "geetest",
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
    if (lower.includes(p)) return unavailable("anti-bot", status, p);
  }
  for (const p of BLOCK_TITLE_PATTERNS) {
    if (title.includes(p)) return unavailable("anti-bot", status, `title: ${p}`);
  }
  if (status >= 400) {
    for (const p of SOFT_BLOCK_PATTERNS) {
      if (lower.includes(p)) return unavailable("anti-bot", status, p);
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

function classifyJsonContent(text: string, listRule: string, status: number): CheckOutcome {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // 声称是 JSON 却解析不出，通常是拦截页或接口改版
    return unavailable("invalid-response", status, "响应不是合法 JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    return unavailable("invalid-response", status, "JSON 顶层不是对象或数组");
  }

  if (listRule) {
    const path = readJsonPath(parsed, listRule);
    if (path.supported) {
      if (path.value === undefined || path.value === null) {
        return unavailable("rule-miss", status, `bookList 取值为空: ${listRule}`);
      }
      if (Array.isArray(path.value)) {
        return path.value.length > 0
          ? available("search-hit", status, `${path.value.length} 条结果`)
          : unavailable("empty-result", status, "bookList 为空数组");
      }
      return available("search-hit", status);
    }
  }

  if (Array.isArray(parsed)) {
    return parsed.length > 0
      ? available("search-hit", status, `${parsed.length} 条结果`)
      : unavailable("empty-result", status, "顶层数组为空");
  }
  return available("search-response", status);
}

function classifyHtmlContent(text: string, listRule: string, status: number): CheckOutcome {
  const tokens = extractHtmlRuleTokens(listRule);
  if (!tokens.length) {
    // 规则里没有可校验的字面特征（纯 XPath 轴、JS 规则等），只能认响应正常
    return available("search-response", status);
  }
  for (const token of tokens) {
    if (text.includes(token)) return available("search-hit", status, token);
  }
  return unavailable("rule-miss", status, `未命中 bookList 特征: ${tokens.join(", ")}`);
}

/**
 * 从 bookList 规则里提取可做存在性检查的字面 token（类名 / id）。
 * 覆盖阅读 App 的几种规则语法：默认规则 class.xxx、CSS 选择器、XPath 属性谓词。
 * 提取不到就返回空数组 —— 宁可不判定，也不能凭猜测判失效。
 */
function extractHtmlRuleTokens(rule: string): string[] {
  if (!rule || /@js:|<js>/i.test(rule)) return [];

  // || 是备选规则、%% 是交替取值，只看第一段就够定位特征
  const head = rule
    .split(/\|\||%%/)[0]
    .replace(/^@(css|xpath|json|filter)\s*:/i, "")
    .trim();

  const tokens = new Set<string>();
  const push = (raw?: string) => {
    const v = (raw || "").trim();
    // 过短的 token（tag.li、.a）没有判别力，命不中也说明不了问题
    if (v.length >= 3 && /^[A-Za-z][\w-]*$/.test(v)) tokens.add(v);
  };

  for (const m of head.matchAll(/\b(?:class|id)\.([\w-]+)/gi)) push(m[1]);
  for (const m of head.matchAll(/@(?:class|id)\s*=\s*["']([^"']+)["']/gi)) {
    for (const part of m[1].split(/\s+/)) push(part);
  }
  for (const m of head.matchAll(/[.#]([A-Za-z][\w-]{2,})/g)) push(m[1]);

  return [...tokens].slice(0, 4);
}

/**
 * 极简 JSONPath 取值，只支持 `$.a.b[0]` 与 `$.a[*]` 这类直路径。
 * 遇到递归下降、过滤器、切片等不支持的语法就报 unsupported，交由上层放行。
 */
function readJsonPath(root: any, rawPath: string): { supported: boolean; value?: any } {
  const path = rawPath.replace(/^@json:/i, "").trim();
  if (!path.startsWith("$")) return { supported: false };

  const rest = path.slice(1);
  if (!rest) return { supported: true, value: root };
  if (/\.\.|\?|\(|,|:/.test(rest)) return { supported: false };

  const stepRe = /\.([\w-]+)|\[\s*(\*|\d+)\s*\]|\[\s*'([^']+)'\s*\]|\[\s*"([^"]+)"\s*\]/g;
  let cursor = 0;
  let value: any = root;

  for (const m of rest.matchAll(stepRe)) {
    if (m.index !== cursor) return { supported: false }; // 中间有无法识别的语法
    cursor = m.index + m[0].length;

    if (value === null || value === undefined) return { supported: true, value: undefined };

    const star = m[2] === "*";
    if (star) {
      // [*] 展开：值本身就是要遍历的集合
      if (!Array.isArray(value) && typeof value === "object") value = Object.values(value);
      continue;
    }
    const key = m[1] ?? m[3] ?? m[4] ?? m[2];
    value = typeof value === "object" ? value[key as any] : undefined;
  }

  if (cursor !== rest.length) return { supported: false };
  return { supported: true, value };
}

// ─────────────────────────────────────────────────────────────────────
// 降级校验与编解码
// ─────────────────────────────────────────────────────────────────────

/** 没有 searchUrl 时的兜底：只验证源站域名是否存活 */
async function checkHomepage(bookSourceUrl: string, options: CheckOptions): Promise<CheckOutcome> {
  if (!/^https?:\/\//i.test(bookSourceUrl)) {
    return unavailable("invalid-url", undefined, `非 HTTP(S) 源地址: ${bookSourceUrl}`);
  }
  const req: SearchRequest = {
    url: bookSourceUrl,
    method: "GET",
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    charset: null,
    keyword: DEFAULT_KEYWORD,
    keywordEncodingUnsupported: false,
  };
  const fetched = await fetchWithRetry(req, options);
  if ("outcome" in fetched) return fetched.outcome;

  const statusOutcome = classifyStatus(fetched.res.status);
  if (statusOutcome) return statusOutcome;
  return available("homepage-ok", fetched.res.status, "书源未配置 searchUrl");
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
