import type { Env } from "./types";

/**
 * 还原对外可访问的地址。
 *
 * 反代通常以明文 HTTP 转发到容器，直接取 new URL(request.url).origin 会得到
 * http://域名:8443 这种协议错配的地址。写进书源后 nginx 回一个
 * 「400 The plain HTTP request was sent to HTTPS port」HTML 页，
 * App 按 JSON 规则解析得到 0 条 —— 请求成功、结果为空、不报错，极难排查。
 * 因此优先采信反代头。
 */
export function publicOrigin(request: Request): string {
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

export function buildReviewRule(origin: string, token: string) {
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


export interface ReviewRulePolicy {
  enabled: boolean;
  markName: boolean;
  mark: string;
  token: string;
}

export async function loadReviewRulePolicy(env: Env): Promise<ReviewRulePolicy> {
  const rows = await env.DB.prepare("SELECT key, value FROM system_config WHERE key IN ('review_auto_inject', 'review_auto_mark_name', 'review_auto_mark', 'review_token')").all();
  const values = Object.fromEntries((rows.results as any[]).map(row => [row.key, String(row.value ?? "")]));
  return {
    enabled: values.review_auto_inject !== "0" && values.review_auto_inject !== "false",
    markName: values.review_auto_mark_name !== "0" && values.review_auto_mark_name !== "false",
    mark: values.review_auto_mark?.trim() || "💬",
    token: values.review_token?.trim() || "",
  };
}

/** Recognize the generated schema, not unrelated rules using a similar URL path. */
export function isManagedReviewRule(value: any): boolean {
  return !!value && typeof value === "object" &&
    String(value.reviewSummaryUrl ?? "").includes("/review/summary?book={{encodeURIComponent(book.name)}}") &&
    value.summaryListRule === "$.list" && value.summaryParagraphIndexRule === "$.paraIndex" &&
    value.detailListRule === "$.items" && String(value.reviewDetailUrl ?? "").includes("/review/detail?");
}

/** Decorate a detached subscription object; do not rewrite source validity or raw cache data. */
export function withAutomaticReviewRule(source: any, rule: ReturnType<typeof buildReviewRule>, policy: ReviewRulePolicy): any {
  if (!source || typeof source !== "object" || Array.isArray(source) || String(source.mainJs ?? "").trim()) return source;
  const owned = isManagedReviewRule(source.ruleReview);
  if (!owned && source.ruleReview && (typeof source.ruleReview !== "object" || Object.keys(source.ruleReview).length)) return source;
  const result = { ...source };
  if (policy.enabled) result.ruleReview = rule;
  else if (owned) result.ruleReview = {};
  else return source;

  let name = String(source.bookSourceName ?? "");
  // Preserve original emoji names; only remove known review markers from rules we manage.
  if (owned) {
    for (const prefix of new Set([policy.mark, "💬", "[评]", "[段评]"])) {
      while (name.startsWith(prefix)) name = name.slice(prefix.length).trimStart();
    }
  }
  if (policy.enabled && policy.markName && !name.startsWith(policy.mark)) name = policy.mark + name;
  if (name !== source.bookSourceName) result.bookSourceName = name;
  return result;
}

export async function automaticallyInjectReviewRules(raw: string, request: Request, env: Env): Promise<string> {
  const policy = await loadReviewRulePolicy(env);
  const rule = buildReviewRule(publicOrigin(request), policy.token);
  const sources = JSON.parse(raw);
  if (!Array.isArray(sources)) throw new Error("书源订阅缓存不是数组");
  return JSON.stringify(sources.map(source => withAutomaticReviewRule(source, rule, policy)));
}
