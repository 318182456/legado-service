import { Env, CACHE_TTL } from "./types";
import { SCHEMA_STATEMENTS } from "./schema-statements";
import fs from "fs-extra";
import path from "path";

// ─── 工具函数 ─────────────────────────────────────────────────────

/** 字符串哈希工具 (Web Crypto API) */
export async function hashText(text: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-1", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 标准 JSON 响应 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** 错误响应 */
export function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

/** 成功响应 */
export function ok(data?: unknown): Response {
  return json({ ok: true, ...(data !== undefined ? { data } : {}) });
}

/** 鉴权检查（写操作用） */
export function checkAuth(request: Request, env: Env): boolean {
  if (!env.API_SECRET) return true; // 未配置则跳过鉴权（开发模式）
  const auth = request.headers.get("Authorization") ?? "";
  return auth === `Bearer ${env.API_SECRET}`;
}

/** 解析请求体 JSON */
export async function parseBody<T = Record<string, unknown>>(
  request: Request
): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/**
 * 从上游 URL 抓取书源 JSON 数组
 * 兼容 Legado 常见书源格式：JSON 数组 或 单个对象
 */
export async function fetchSources(url: string): Promise<unknown[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "LegadoSubscription/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const text = await res.text();
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) return [parsed];
  throw new Error("不支持的书源格式");
}

/**
 * 从上游 URL 抓取净化规则 JSON 数组
 * 兼容 Legado 净化规则格式：JSON 数组
 */
export async function fetchRules(url: string): Promise<unknown[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "LegadoSubscription/1.0" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const text = await res.text();
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  throw new Error("净化规则须为 JSON 数组");
}

/**
 * 使书源订阅与 D1 同步，返回入库数量
 */
export async function syncSourceSubscription(
  env: Env,
  subId: number,
  url: string,
  preFetchedItems?: any[]
): Promise<number> {
  const rawItems = preFetchedItems ?? await fetchSources(url);
  
  // 1. 过滤无效书源并按 URL 去重 (模拟阅读 App 底层机制)
  const itemsMap = new Map<string, Record<string, unknown>>();
  for (const s of rawItems) {
    if (typeof s !== "object" || s === null) continue;
    const src = s as Record<string, unknown>;
    const bsUrl = String(src["bookSourceUrl"] ?? src["sourceUrl"] ?? "").trim();
    const name = String(src["bookSourceName"] ?? src["name"] ?? "").trim();
    
    // 剔除空壳书源
    if (!bsUrl || !name) continue;
    
    // Map 自动以后来者覆盖同 URL 的旧书源
    itemsMap.set(bsUrl, src);
  }
  
  const items = Array.from(itemsMap.values());
  let count = 0;

  // 批量 upsert（D1 每批最多 ~100 条以避免超时）
  const BATCH = 50;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const stmts = chunk
      .map(async (src) => {
        const bsUrl = String(src["bookSourceUrl"] ?? src["sourceUrl"] ?? "").trim();
        const name = String(src["bookSourceName"] ?? src["name"] ?? "未知书源").trim();
        const group = String(src["bookSourceGroup"] ?? src["group"] ?? "");
        const rawJson = JSON.stringify(src);
        
        // 预解析测试链接：在同步阶段完成正则扫描，避免测试阶段 CPU 超时
        let testUrl = bsUrl;
        try {
          const searchUrl = src["searchUrl"];
          if (typeof searchUrl === 'string' && searchUrl) {
            let urlPart = searchUrl.split(',{')[0];
            urlPart = urlPart.replace(/\{\{key\}\}/g, encodeURIComponent('我的'));
            if (urlPart.startsWith('http')) {
              testUrl = urlPart;
            } else {
              try {
                testUrl = new URL(urlPart, bsUrl).toString();
              } catch (_) {
                testUrl = bsUrl.replace(/\/$/, '') + '/' + urlPart.replace(/^\//, '');
              }
            }
          }
        } catch (_) {}

        // 生成哈希以绕过 Postgres 索引限制
        const urlHash = await hashText(bsUrl);
        
        return env.DB.prepare(
          `INSERT INTO sources (subscription_id, book_source_url, name, group_name, raw_json, test_url, url_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(subscription_id, url_hash)
           DO UPDATE SET name=excluded.name, group_name=excluded.group_name,
                         raw_json=excluded.raw_json, test_url=excluded.test_url, updated_at=excluded.updated_at
           WHERE sources.raw_json != excluded.raw_json`
        ).bind(subId, bsUrl, name, group, rawJson, testUrl, urlHash);
      });
    
    // 需要等待所有哈希生成完毕
    const resolvedStmts = await Promise.all(stmts);

    if (resolvedStmts.length > 0) {
      await env.DB.batch(resolvedStmts);
      count += resolvedStmts.length;
    }
  }

  // 更新订阅状态（用实际行数而非语句数）
  const actualCountRow = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM sources WHERE subscription_id=?`
  ).bind(subId).first() as any;
  const actualCount = actualCountRow?.cnt ?? count;

  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=? WHERE id=?`
  )
    .bind(actualCount, subId)
    .run();

  return actualCount;
}

/**
 * 使净化规则订阅与 D1 同步，返回入库数量
 */
export async function syncRuleSubscription(
  env: Env,
  subId: number,
  url: string,
  preFetchedItems?: any[]
): Promise<number> {
  const rawItems = preFetchedItems ?? await fetchRules(url);
  
  const itemsMap = new Map<string, Record<string, unknown>>();
  for (const r of rawItems) {
    if (typeof r !== "object" || r === null) continue;
    const rule = r as Record<string, unknown>;
    const name = String(rule["name"] ?? rule["ruleName"] ?? "").trim();
    const pattern = String(rule["regex"] ?? rule["pattern"] ?? "").trim();
    
    if (!name || !pattern) continue;
    itemsMap.set(name + "::" + pattern, rule);
  }
  
  const items = Array.from(itemsMap.values());
  let count = 0;

  const BATCH = 50;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const stmts = chunk
      .map(async (rule) => {
        const name = String(rule["name"] ?? rule["ruleName"] ?? "").trim();
        const pattern = String(rule["regex"] ?? rule["pattern"] ?? "").trim();
        const replacement = String(rule["replacement"] ?? rule["replace"] ?? "");
        
        // 归一化 JSON 格式，确保阅读 App 能识别名称和模式
        const normalizedRule = {
          ...rule,
          name,
          pattern,
          replacement,
          isRegex: rule["isRegex"] ?? true,
          isEnabled: rule["isEnabled"] ?? rule["enabled"] ?? true
        };
        
        const rawJson = JSON.stringify(normalizedRule);
        
        // 生成哈希以绕过 Postgres 索引限制
        const patternHash = await hashText(pattern);

        return env.DB.prepare(
          `INSERT INTO rules (subscription_id, name, pattern, replacement, raw_json, pattern_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(subscription_id, name, pattern_hash)
           DO UPDATE SET replacement=excluded.replacement,
                         raw_json=excluded.raw_json, updated_at=excluded.updated_at
           WHERE rules.raw_json != excluded.raw_json`
        ).bind(subId, name, pattern, replacement, rawJson, patternHash);
      });
    
    // 需要等待所有哈希生成完毕
    const resolvedStmts = await Promise.all(stmts);

    if (resolvedStmts.length > 0) {
      await env.DB.batch(resolvedStmts);
      count += resolvedStmts.length;
    }
  }

  const actualCountRow2 = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM rules WHERE subscription_id=?`
  ).bind(subId).first() as any;
  const actualCount2 = actualCountRow2?.cnt ?? count;

  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=? WHERE id=?`
  )
    .bind(actualCount2, subId)
    .run();

  return actualCount2;
}

/**
 * 使目录规则订阅与 D1 同步，返回入库数量
 */
export async function syncTxtTocRuleSubscription(
  env: Env,
  subId: number,
  url: string,
  preFetchedItems?: any[]
): Promise<number> {
  const rawItems = preFetchedItems ?? await fetchRules(url);
  
  const itemsMap = new Map<string, Record<string, unknown>>();
  for (const r of rawItems) {
    if (typeof r !== "object" || r === null) continue;
    const rule = r as Record<string, unknown>;
    const name = String(rule["name"] ?? "").trim();
    const rulePattern = String(rule["rule"] ?? "").trim();
    
    if (!name || !rulePattern) continue;
    itemsMap.set(name + "::" + rulePattern, rule);
  }
  
  const items = Array.from(itemsMap.values());
  let count = 0;

  const BATCH = 50;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const stmts = chunk
      .map(async (rule) => {
        const name = String(rule["name"] ?? "").trim();
        const rulePattern = String(rule["rule"] ?? "").trim();
        const example = rule["example"] ? String(rule["example"]) : null;
        const serialNumber = Number(rule["serialNumber"] ?? rule["serial_number"] ?? -1);
        const enabled = rule["enable"] ?? rule["enabled"] ?? true ? 1 : 0;
        
        const normalizedRule = {
          ...rule,
          name,
          rule: rulePattern,
          example,
          serialNumber,
          enable: !!enabled
        };
        
        const rawJson = JSON.stringify(normalizedRule);
        const ruleHash = await hashText(rulePattern);

        return env.DB.prepare(
          `INSERT INTO txt_toc_rules (subscription_id, name, rule, example, serial_number, enabled, raw_json, rule_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(subscription_id, name, rule_hash)
           DO UPDATE SET example=excluded.example, serial_number=excluded.serial_number,
                         enabled=excluded.enabled, raw_json=excluded.raw_json, updated_at=excluded.updated_at
           WHERE txt_toc_rules.raw_json != excluded.raw_json`
        ).bind(subId, name, rulePattern, example, serialNumber, enabled, rawJson, ruleHash);
      });
    
    const resolvedStmts = await Promise.all(stmts);

    if (resolvedStmts.length > 0) {
      await env.DB.batch(resolvedStmts);
      count += resolvedStmts.length;
    }
  }

  const actualCountRow3 = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM txt_toc_rules WHERE subscription_id=?`
  ).bind(subId).first() as any;
  const actualCount3 = actualCountRow3?.cnt ?? count;

  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=? WHERE id=?`
  )
    .bind(actualCount3, subId)
    .run();

  return actualCount3;
}

/**
 * 使字典规则订阅与 D1 同步，返回入库数量
 */
export async function syncDictRuleSubscription(
  env: Env,
  subId: number,
  url: string,
  preFetchedItems?: any[]
): Promise<number> {
  const rawItems = preFetchedItems ?? await fetchRules(url);
  
  const itemsMap = new Map<string, Record<string, unknown>>();
  for (const r of rawItems) {
    if (typeof r !== "object" || r === null) continue;
    const rule = r as Record<string, unknown>;
    const name = String(rule["name"] ?? "").trim();
    const urlRule = String(rule["urlRule"] ?? rule["url_rule"] ?? "").trim();
    
    if (!name || !urlRule) continue;
    itemsMap.set(name, rule);
  }
  
  const items = Array.from(itemsMap.values());
  let count = 0;

  const BATCH = 50;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const stmts = chunk
      .map(async (rule) => {
        const name = String(rule["name"] ?? "").trim();
        const urlRule = String(rule["urlRule"] ?? rule["url_rule"] ?? "").trim();
        const showRule = String(rule["showRule"] ?? rule["show_rule"] ?? "");
        const sortNumber = Number(rule["sortNumber"] ?? rule["sort_number"] ?? 0);
        const enabled = rule["enabled"] ?? rule["enable"] ?? true ? 1 : 0;
        
        const normalizedRule = {
          ...rule,
          name,
          urlRule,
          showRule,
          sortNumber,
          enabled: !!enabled
        };
        
        const rawJson = JSON.stringify(normalizedRule);

        return env.DB.prepare(
          `INSERT INTO dict_rules (subscription_id, name, url_rule, show_rule, enabled, sort_number, raw_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(subscription_id, name)
           DO UPDATE SET url_rule=excluded.url_rule, show_rule=excluded.show_rule,
                         enabled=excluded.enabled, sort_number=excluded.sort_number,
                         raw_json=excluded.raw_json, updated_at=excluded.updated_at
           WHERE dict_rules.raw_json != excluded.raw_json`
        ).bind(subId, name, urlRule, showRule, enabled, sortNumber, rawJson);
      });
    
    const resolvedStmts = await Promise.all(stmts);

    if (resolvedStmts.length > 0) {
      await env.DB.batch(resolvedStmts);
      count += resolvedStmts.length;
    }
  }

  const actualCountRow4 = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM dict_rules WHERE subscription_id=?`
  ).bind(subId).first() as any;
  const actualCount4 = actualCountRow4?.cnt ?? count;

  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=? WHERE id=?`
  )
    .bind(actualCount4, subId)
    .run();

  return actualCount4;
}

/**
 * 重建 KV 缓存
 */
export async function rebuildCache(env: Env, type: "source" | "rule" | "txtTocRule" | "dictRule") {
  if (type === "source") {
    // 跨订阅全局去重：使用 url_hash 避免长文本索引限制
    const rows = await env.DB.prepare(
      `SELECT raw_json, group_name FROM sources WHERE id IN (SELECT MIN(id) FROM sources WHERE enabled=1 GROUP BY url_hash) ORDER BY id`
    ).all();
    
    // 安全 JSON 构建：验证每条 raw_json，跳过损坏数据
    const items: string[] = [];
    for (const r of rows.results as any[]) {
      try {
        const item = JSON.parse(r.raw_json);
        item.bookSourceGroup = r.group_name || "";
        items.push(JSON.stringify(item));
      } catch (_) { /* 跳过损坏数据，不污染整个缓存 */ }
    }
    const mergedStr = "[" + items.join(",") + "]";
    
    await env.KV.put("sources", mergedStr, { expirationTtl: CACHE_TTL });
  } else if (type === "rule") {
    // 净化规则去重：按 name 和 pattern_hash 去重
    const rows = await env.DB.prepare(
      `SELECT raw_json FROM rules WHERE id IN (SELECT MIN(id) FROM rules WHERE enabled=1 GROUP BY name, pattern_hash) ORDER BY id`
    ).all();
    
    const items: string[] = [];
    for (const r of rows.results as any[]) {
      try { JSON.parse(r.raw_json); items.push(r.raw_json as string); } catch (_) {}
    }
    await env.KV.put("rules", "[" + items.join(",") + "]", { expirationTtl: CACHE_TTL });
  } else if (type === "txtTocRule") {
    // 目录规则去重：按 name 和 rule_hash 去重
    const rows = await env.DB.prepare(
      `SELECT raw_json FROM txt_toc_rules WHERE id IN (SELECT MIN(id) FROM txt_toc_rules WHERE enabled=1 GROUP BY name, rule_hash) ORDER BY id`
    ).all();
    
    const items: string[] = [];
    for (const r of rows.results as any[]) {
      try { JSON.parse(r.raw_json); items.push(r.raw_json as string); } catch (_) {}
    }
    await env.KV.put("txtTocRules", "[" + items.join(",") + "]", { expirationTtl: CACHE_TTL });
  } else if (type === "dictRule") {
    // 字典规则去重：按 name 去重
    const rows = await env.DB.prepare(
      `SELECT raw_json FROM dict_rules WHERE id IN (SELECT MIN(id) FROM dict_rules WHERE enabled=1 GROUP BY name) ORDER BY id`
    ).all();
    
    const items: string[] = [];
    for (const r of rows.results as any[]) {
      try { JSON.parse(r.raw_json); items.push(r.raw_json as string); } catch (_) {}
    }
    await env.KV.put("dictRules", "[" + items.join(",") + "]", { expirationTtl: CACHE_TTL });
  }
}


/**
 * 校验单条书源的真实可用性 (高精度过滤失效书源)
 * 模拟阅读 App 对 searchUrl 进行解析 (支持 GET/POST、自定义 Headers/Body、自定义校验关键字)
 */
export async function checkBookSourceRealAvailability(
  rawJsonStr: string,
  bookSourceUrl: string
): Promise<boolean> {
  try {
    const src = JSON.parse(rawJsonStr);
    const searchUrl = src.searchUrl;
    
    // 如果没有配置搜索 URL，降级为测试源域名本身
    if (typeof searchUrl !== "string" || !searchUrl.trim()) {
      const res = await fetch(bookSourceUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(5000)
      });
      await res.body?.cancel().catch(() => {});
      return res.status >= 200 && res.status < 400;
    }

    // 获取校验关键字，优先使用书源自带的 checkKeyWord 字段
    let keyWord = "我的";
    if (src.ruleSearch && typeof src.ruleSearch.checkKeyWord === "string" && src.ruleSearch.checkKeyWord.trim()) {
      keyWord = src.ruleSearch.checkKeyWord.trim();
    } else if (typeof src.checkKeyWord === "string" && src.checkKeyWord.trim()) {
      keyWord = src.checkKeyWord.trim();
    }

    // 解析 searchUrl 中的请求配置和参数
    let urlStr = searchUrl.trim();
    let method = "GET";
    let headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    };
    let body: any = undefined;

    // 尝试解析书源全局自带的 headers 配置
    if (src.header) {
      try {
        const globalHeaders = typeof src.header === "string" ? JSON.parse(src.header) : src.header;
        if (globalHeaders && typeof globalHeaders === "object") {
          for (const [k, v] of Object.entries(globalHeaders)) {
            headers[k] = String(v);
          }
        }
      } catch (_) {}
    }

    // 解析 searchUrl 中的逗号选项 (逗号加左花括号 ',{')
    const commaIndex = urlStr.indexOf(",{");
    const alternateCommaIndex = urlStr.indexOf(",\n{");
    const index = commaIndex !== -1 ? commaIndex : alternateCommaIndex;

    if (index !== -1) {
      const optionsStr = urlStr.substring(index + 1).trim();
      urlStr = urlStr.substring(0, index).trim();
      try {
        const options = JSON.parse(optionsStr);
        if (options.method) method = options.method.toUpperCase();
        if (options.headers) {
          for (const [k, v] of Object.entries(options.headers)) {
            headers[k] = String(v);
          }
        }
        if (options.body) body = options.body;
      } catch (_) {
        // 容错：使用 Function 评估宽松的 JS 对象形式
        try {
          const relaxedJson = new Function(`return ${optionsStr}`)();
          if (relaxedJson.method) method = relaxedJson.method.toUpperCase();
          if (relaxedJson.headers) {
            for (const [k, v] of Object.entries(relaxedJson.headers)) {
              headers[k] = String(v);
            }
          }
          if (relaxedJson.body) body = relaxedJson.body;
        } catch (_) {}
      }
    }

    // 替换模板变量
    const encodedKeyWord = encodeURIComponent(keyWord);
    const replacePlaceholders = (str: string): string => {
      return str
        .replace(/\{\{key\}\}/g, encodedKeyWord)
        .replace(/\{\{searchKey\}\}/g, encodedKeyWord);
    };
    const replacePlaceholdersRaw = (str: string): string => {
      return str
        .replace(/\{\{key\}\}/g, keyWord)
        .replace(/\{\{searchKey\}\}/g, keyWord);
    };

    urlStr = replacePlaceholders(urlStr);

    // 确保是绝对路径
    if (!urlStr.startsWith("http")) {
      try {
        urlStr = new URL(urlStr, bookSourceUrl).toString();
      } catch (_) {
        urlStr = bookSourceUrl.replace(/\/$/, "") + "/" + urlStr.replace(/^\//, "");
      }
    }

    // 替换请求头中的占位符
    for (const hKey in headers) {
      headers[hKey] = replacePlaceholdersRaw(headers[hKey]);
    }

    // 替换请求体中的占位符与格式化
    if (body) {
      if (typeof body === "string") {
        const trimmedBody = body.trim();
        // 启发式：如果看起来是 form-urlencoded，进行 url 编码
        if (trimmedBody.includes("=") && !trimmedBody.startsWith("{")) {
          body = trimmedBody.split("&").map(pair => {
            const parts = pair.split("=");
            if (parts.length === 2) {
              return `${parts[0]}=${encodeURIComponent(parts[1] === "{{key}}" || parts[1] === "{{searchKey}}" ? keyWord : replacePlaceholdersRaw(parts[1]))}`;
            }
            return pair;
          }).join("&");
          if (!headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
          }
        } else {
          body = replacePlaceholdersRaw(body);
        }
      } else if (typeof body === "object") {
        body = JSON.stringify(body);
        body = replacePlaceholdersRaw(body);
        if (!headers["Content-Type"] && !headers["content-type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
    }

    // 发起真实的 Fetch 搜索请求
    const res = await fetch(urlStr, {
      method,
      headers,
      body: method !== "GET" && method !== "HEAD" ? body : undefined,
      signal: AbortSignal.timeout(10000) // 10秒超时
    });

    if (res.status < 200 || res.status >= 400) {
      return false;
    }

    // 检测是否重定向到登录/授权等跳转页面 (算作无效源)
    if (res.redirected && res.url) {
      try {
        const finalUrl = new URL(res.url);
        const lowerPath = finalUrl.pathname.toLowerCase();
        if (
          lowerPath.includes("login") ||
          lowerPath.includes("signin") ||
          lowerPath.includes("register") ||
          lowerPath.includes("auth") ||
          lowerPath.includes("signup")
        ) {
          console.log(`[checkBookSourceRealAvailability] 检测到登录重定向: ${res.url}`);
          return false;
        }
      } catch (_) {}
    }

    const text = await res.text();

    // 1. 内容过短或为空判定为失效 (正常搜索页面或 JSON 一般都有相当的内容)
    if (!text || text.length < 200) {
      return false;
    }

    // 2. 检测常见的 Cloudflare 验证码、盾牌防护、安全阻断、登录限制、人机交互等页面
    const lowerText = text.toLowerCase();
    if (
      lowerText.includes("cloudflare") ||
      lowerText.includes("security challenge") ||
      lowerText.includes("5秒盾") ||
      lowerText.includes("safety check") ||
      lowerText.includes("just a moment") ||
      lowerText.includes("captcha") ||
      lowerText.includes("challenge-form") ||
      lowerText.includes("recaptcha") ||
      lowerText.includes("hcaptcha") ||
      lowerText.includes("请输入验证码") ||
      lowerText.includes("输入验证码") ||
      lowerText.includes("滑块验证") ||
      lowerText.includes("安全验证") ||
      lowerText.includes("验证后继续") ||
      lowerText.includes("请先登录") ||
      lowerText.includes("需要登录") ||
      lowerText.includes("请登录后继续") ||
      lowerText.includes("必须登录") ||
      lowerText.includes("登录后查看")
    ) {
      console.log(`[checkBookSourceRealAvailability] 检测到人机验证、安全拦截或需要登录: ${bookSourceUrl}`);
      return false;
    }

    // 3. 根据响应格式对返回结果进行特征校验，判断是否确实匹配搜索规则
    const isJsonResponse = res.headers.get("content-type")?.includes("application/json") || 
                           (text.trim().startsWith("[") || text.trim().startsWith("{"));

    if (isJsonResponse) {
      try {
        const parsedJson = JSON.parse(text);
        if (parsedJson && typeof parsedJson === "object") {
          // 如果书源定义了 bookList JSONPath 路径
          if (src.ruleSearch && src.ruleSearch.bookList) {
            const listRule = src.ruleSearch.bookList;
            if (listRule.startsWith("$.")) {
              const paths = listRule.substring(2).split(".");
              let currentObj: any = parsedJson;
              for (const p of paths) {
                if (currentObj && typeof currentObj === "object") {
                  currentObj = currentObj[p];
                }
              }
              if (Array.isArray(currentObj) && currentObj.length === 0) {
                return true;
              }
            }
          }
          return true;
        }
        return false;
      } catch (_) {
        return false;
      }
    } else {
      // 4. HTML 校验：通过 ruleSearch 中的 bookList / name 进行关键字或特定 HTML 特征比对
      if (src.ruleSearch && src.ruleSearch.bookList) {
        const listRule = src.ruleSearch.bookList;
        if (listRule.startsWith(".")) {
          const className = listRule.substring(1).split(/[#\s:.]/)[0];
          if (className && !text.includes(className)) {
            return false;
          }
        } else if (listRule.startsWith("#")) {
          const idName = listRule.substring(1).split(/[#\s:.]/)[0];
          if (idName && !text.includes(idName)) {
            return false;
          }
        }
      }
      return true;
    }
  } catch (err) {
    console.error(`[checkBookSourceRealAvailability] 错误: ${bookSourceUrl}`, err);
    return false;
  }
}



// ─── Passkey 工具 ────────────────────────────────────────────────

/** Uint8Array -> base64url */
export function u8ToB64url(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** base64url -> Uint8Array */
export function b64urlToU8(s: string): Uint8Array {
  const b = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  return new Uint8Array(
    atob(b)
      .split("")
      .map((c) => c.charCodeAt(0))
  );
}

// ─── 数据库初始化 (参照 NodeWarden) ───────────────────────────────

export let schemaVerified = false;
let initPromise: Promise<void> | null = null;

/**
 * 确保数据库表结构已初始化与升级
 */
export async function ensureDatabase(env: Env): Promise<void> {
  if (schemaVerified) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    let needInit = false;
    let fileVersion = "";
    let dbVersion = "";

    // 1. 读取本地版本文件
    try {
      const versionPath = path.join(process.cwd(), "VERSION");
      if (await fs.pathExists(versionPath)) {
        fileVersion = (await fs.readFile(versionPath, "utf-8")).trim();
      }
    } catch (err) {
      console.error("读取 VERSION 文件失败:", err);
    }

    // 2. 尝试获取数据库当前版本
    try {
      const dbVerRow = await env.DB.prepare("SELECT value FROM system_config WHERE key = 'version'").first() as any;
      dbVersion = dbVerRow?.value || "";
    } catch (_) {
      // 如果表不存在或查询报错，说明需要初始化
      needInit = true;
    }

    // 3. 比较版本，如果版本不一致，强制执行初始化与结构升级
    if (fileVersion && dbVersion && fileVersion !== dbVersion) {
      console.log(`检测到版本更新: ${dbVersion} -> ${fileVersion}，强制执行数据库结构升级...`);
      needInit = true;
    }

    // 4. 如果不需要强制升级，且 KV 中标记已验证，进行快速验证
    if (!needInit) {
      const isVerified = await env.KV.get("db_verified");
      if (isVerified === "true") {
        try {
          // 快速检查核心表
          await env.DB.prepare("SELECT 1 FROM subscriptions LIMIT 1").run();
          schemaVerified = true;
          return;
        } catch (e) {
          console.warn("数据库标志位存在但核心表缺失，正在强制重新初始化...");
          needInit = true;
        }
      } else {
        needInit = true;
      }
    }

    console.log("正在执行数据库初始化与结构同步...");
    let successCount = 0;
    let failCount = 0;

    try {
      // 开启外键支持 (Postgres 不需要这个，但 D1 需要)
      try {
        await env.DB.prepare("PRAGMA foreign_keys = ON").run();
      } catch (_) {}

      // 逐条执行初始化语句，避免单个语句失败导致全局回滚
      for (const sql of SCHEMA_STATEMENTS) {
        try {
          await env.DB.prepare(sql).run();
          successCount++;
        } catch (e: any) {
          const msg = e.message?.toLowerCase() || "";
          const errCode = String(e.code || "");
          // 忽略已经存在的错误 (包含 PostgreSQL 23505 唯一性约束冲突、索引已存在、字段已存在等)
          if (
            msg.includes("already exists") || 
            msg.includes("duplicate key") ||
            msg.includes("duplicate_key") ||
            errCode === "23505" ||
            msg.includes("duplicate column") ||
            msg.includes("already a column") ||
            msg.includes("does not exist") ||
            msg.includes("syntax error") // 忽略 SQLite 不支持的 Postgres 语法 (如 DROP CONSTRAINT)
          ) {
            successCount++;
          } else {
            console.error(`SQL 执行失败: ${sql.substring(0, 50)}...`, e);
            failCount++;
          }
        }
      }

      // 只要有成功的语句，且没有严重的致命错误，就标记为成功
      if (successCount > 0 && failCount === 0) {
        await env.KV.put("db_verified", "true");
        schemaVerified = true;
        console.log(`数据库初始化与升级完成: 成功 ${successCount} 条`);

        // ─── 更新版本号到数据库 ──────────────────
        if (fileVersion) {
          try {
            await env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
              .bind(fileVersion)
              .run();
            await env.KV.put("last_version_update", JSON.stringify({
              old: dbVersion,
              new: fileVersion,
              time: new Date().toISOString()
            }));
            console.log(`版本号同步成功: ${fileVersion}`);
          } catch (verErr) {
            console.error("版本号更新失败:", verErr);
          }
        }
        // ──────────────────────────────────
      } else {
        console.error(`数据库初始化不完整: 成功 ${successCount}, 失败 ${failCount}`);
        throw new Error(`数据库初始化不完整: 成功 ${successCount}, 失败 ${failCount}`);
      }
    } catch (e: any) {
      console.error("数据库初始化过程发生致命错误:", e);
      throw e;
    }
  })();

  try {
    await initPromise;
  } catch (err) {
    initPromise = null; // 失败后清空，允许下次重试
    throw err;
  }
}

