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

  // 更新订阅状态
  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=? WHERE id=?`
  )
    .bind(count, subId)
    .run();

  return count;
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

  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=? WHERE id=?`
  )
    .bind(count, subId)
    .run();

  return count;
}

/**
 * 重建 KV 缓存（sources / rules）
 */
export async function rebuildCache(env: Env, type: "source" | "rule") {
  if (type === "source") {
    // 跨订阅全局去重：使用 url_hash 避免长文本索引限制
    const rows = await env.DB.prepare(
      `SELECT raw_json FROM sources WHERE id IN (SELECT MIN(id) FROM sources WHERE enabled=1 GROUP BY url_hash) ORDER BY id`
    ).all();
    
    // 直接拼接 raw_json 字符串，完全省去 JSON.parse 和 JSON.stringify 的 CPU 开销
    const mergedStr = "[" + rows.results.map((r) => r.raw_json as string).join(",") + "]";
    
    await env.KV.put("sources", mergedStr, {
      expirationTtl: CACHE_TTL,
    });
  } else {
    // 净化规则去重：按 name 和 pattern_hash 去重
    const rows = await env.DB.prepare(
      `SELECT raw_json FROM rules WHERE id IN (SELECT MIN(id) FROM rules WHERE enabled=1 GROUP BY name, pattern_hash) ORDER BY id`
    ).all();
    
    const mergedStr = "[" + rows.results.map((r) => r.raw_json as string).join(",") + "]";

    await env.KV.put("rules", mergedStr, {
      expirationTtl: CACHE_TTL,
    });
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

/**
 * 确保数据库表结构已初始化与升级
 */
export async function ensureDatabase(env: Env): Promise<void> {
  if (schemaVerified) return;

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
        // 忽略已经存在的错误
        if (
          msg.includes("already exists") || 
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
    }
  } catch (e: any) {
    console.error("数据库初始化过程发生致命错误:", e);
    throw e;
  }
}
