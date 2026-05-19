import { Env } from "../types";
import {
  ok,
  err,
  parseBody,
  syncSourceSubscription,
  syncRuleSubscription,
  syncTxtTocRuleSubscription,
  syncDictRuleSubscription,
  rebuildCache,
} from "../utils";
import { runWorkerPool } from "./worker-runner";

export async function handleListSubscriptions(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT * FROM subscriptions ORDER BY created_at DESC").all();
  return ok(results);
}

export async function handleAddSubscription(request: Request, env: Env, ctx?: any): Promise<Response> {
  const body = await parseBody<{ name?: string; url: string; type: "source" | "rule" | "txtTocRule" | "dictRule" }>(request);
  if (!body?.url) return err("url 不能为空");
  const { meta } = await env.DB.prepare("INSERT INTO subscriptions (name, url, type) VALUES (?, ?, ?)").bind(body.name ?? "", body.url, body.type).run();
  const newId = Number(meta.last_row_id);
  
  const runInitialSync = async () => {
    try {
      if (body.type === "source") await syncSourceSubscription(env, newId, body.url);
      else if (body.type === "rule") await syncRuleSubscription(env, newId, body.url);
      else if (body.type === "txtTocRule") await syncTxtTocRuleSubscription(env, newId, body.url);
      else if (body.type === "dictRule") await syncDictRuleSubscription(env, newId, body.url);
      await rebuildCache(env, body.type);
      console.log(`新订阅 [${body.name || body.url}] 首次后台同步与缓存重建已完成。`);
    } catch (e) {
      console.warn("首次后台同步失败:", e);
    }
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(runInitialSync());
  } else {
    runInitialSync().catch(console.error);
  }

  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id=?").bind(newId).first();
  return ok(sub);
}

export async function handleDeleteSubscription(env: Env, id: number): Promise<Response> {
  const sub = (await env.DB.prepare("SELECT type FROM subscriptions WHERE id=?").bind(id).first()) as any;
  if (!sub) return err("不存在", 404);
  await env.DB.prepare("DELETE FROM subscriptions WHERE id=?").bind(id).run();
  await rebuildCache(env, sub.type);
  return ok();
}

export async function handleToggleSubscription(request: Request, env: Env, id: number): Promise<Response> {
  const body = await parseBody<{ enabled: boolean }>(request);
  const enabled = body?.enabled ? 1 : 0;
  await env.DB.prepare("UPDATE subscriptions SET enabled=? WHERE id=? AND enabled != ?").bind(enabled, id, enabled).run();
  const sub = (await env.DB.prepare("SELECT type FROM subscriptions WHERE id=?").bind(id).first()) as any;
  if (sub) {
    const table = sub.type === "source"
      ? "sources"
      : sub.type === "rule"
        ? "rules"
        : sub.type === "txtTocRule"
          ? "txt_toc_rules"
          : "dict_rules";
    await env.DB.prepare(`UPDATE ${table} SET enabled=? WHERE subscription_id=? AND enabled != ?`).bind(enabled, id, enabled).run();
    await rebuildCache(env, sub.type);
  }
  return ok();
}

export async function handleSync(env: Env, id: number | null, ctx?: any): Promise<Response> {
  console.log(`[Sync] 收到手动多线程同步请求: ID=${id || "ALL (全局同步)"}`);
  const startTime = Date.now();

  const runSync = async () => {
    const subs = id 
      ? [await env.DB.prepare("SELECT * FROM subscriptions WHERE id=?").bind(id).first()] 
      : (await env.DB.prepare("SELECT * FROM subscriptions WHERE enabled=1").all()).results;
    
    console.log(`[Sync] 发现 ${subs.length} 个待同步订阅...`);

    const itemsToSync = (subs as any[]).map(sub => ({
      id: sub.id,
      url: sub.url,
      type: sub.type,
      name: sub.name
    }));

    // 运行我们的通用多线程任务池！
    await runWorkerPool({
      taskType: "sync-subscriptions",
      items: itemsToSync,
      threadCount: Math.min(4, itemsToSync.length), // 动态按数量分配线程
      concurrencyPerThread: 5, // 订阅抓取通常每线程并发 5 个即可，防被封
      onResult: async (msg) => {
        const sub = itemsToSync.find(x => x.id === msg.id);
        if (!sub) return;

        const subStart = Date.now();
        console.log(`[Sync] 正在保存订阅数据到数据库: [${sub.name || sub.url}]...`);

        if (msg.success) {
          try {
            let count = 0;
            if (sub.type === "source") {
              count = await syncSourceSubscription(env, sub.id, sub.url, msg.rawItems);
            } else if (sub.type === "rule") {
              count = await syncRuleSubscription(env, sub.id, sub.url, msg.rawItems);
            } else if (sub.type === "txtTocRule") {
              count = await syncTxtTocRuleSubscription(env, sub.id, sub.url, msg.rawItems);
            } else if (sub.type === "dictRule") {
              count = await syncDictRuleSubscription(env, sub.id, sub.url, msg.rawItems);
            }
            console.log(`[Sync] 订阅 [${sub.name || sub.url}] 数据库同步成功，入库 ${count} 个项目，耗时: ${Date.now() - subStart}ms`);
          } catch (dbErr: any) {
            console.error(`[Sync] 订阅 [${sub.name || sub.url}] 保存数据库失败:`, dbErr.message || dbErr);
          }
        } else {
          console.error(`[Sync] 订阅 [${sub.name || sub.url}] 抓取/解析失败:`, msg.error);
        }
      },
      onWorkerDone: (t) => {
        console.log(`[Sync] 订阅同步工作线程 ${t + 1} 已圆满完成其分配的分片任务。`);
      }
    });

    console.log("[Sync] 正在重新构建全局缓存...");
    await Promise.all([
      rebuildCache(env, "source"),
      rebuildCache(env, "rule"),
      rebuildCache(env, "txtTocRule"),
      rebuildCache(env, "dictRule")
    ]);
    console.log(`[Sync] 全局同步任务与缓存重建已圆满完成，总耗时: ${Date.now() - startTime}ms`);
  };

  try {
    // 为了让前端 UI 的“立即同步 / 全局同步”加载状态能准确反映实际同步进度，
    // 我们直接同步等待同步完成再返回 Response，而不是丢给后台运行。
    await runSync();
    return ok({ message: "Sync completed successfully" });
  } catch (e: any) {
    console.error("[Sync] 手动同步发生致命错误:", e);
    return err(`同步发生异常: ${e.message || e}`, 500);
  }
}

export async function handleImportSubscriptions(request: Request, env: Env): Promise<Response> {
  try {
    const body = await parseBody<{ subscriptions?: any[] }>(request);
    const list = body?.subscriptions;
    if (!Array.isArray(list)) return err("订阅源列表必须是 JSON 数组");

    // 过滤有效条目
    const validItems = list.filter(item => !!item.sourceUrl);
    if (validItems.length === 0) return ok({ imported: 0 });

    // 批量查询已存在的 URL，避免循环串行 N 次查询
    const urls = validItems.map(item => item.sourceUrl);
    const placeholders = urls.map(() => '?').join(',');
    const existingRows = await env.DB.prepare(
      `SELECT url FROM subscriptions WHERE url IN (${placeholders})`
    ).bind(...urls).all();
    const existingUrls = new Set<string>(existingRows.results.map((r: any) => r.url as string));

    let count = 0;
    const insertStmts: any[] = [];
    const updateStmts: any[] = [];

    for (const item of validItems) {
      const name = item.sourceName || "";
      const group = item.sourceGroup || "";
      const matchText = (name + " " + group).toLowerCase();

      // 智能根据分类名称推测其 type 类型
      let type: "source" | "rule" | "txtTocRule" | "dictRule" = "source";
      if (matchText.includes("规则") || matchText.includes("净化")) {
        type = "rule";
      } else if (matchText.includes("目录")) {
        type = "txtTocRule";
      } else if (matchText.includes("字典")) {
        type = "dictRule";
      }

      if (existingUrls.has(item.sourceUrl)) {
        // 更新现有订阅名称
        updateStmts.push(
          env.DB.prepare("UPDATE subscriptions SET name=? WHERE url=?").bind(name, item.sourceUrl)
        );
      } else {
        // 写入新订阅，默认启用
        insertStmts.push(
          env.DB.prepare("INSERT INTO subscriptions (name, url, type, enabled) VALUES (?, ?, ?, 1)")
            .bind(name, item.sourceUrl, type)
        );
        count++;
      }
    }

    // 批量执行所有写操作
    const allStmts = [...insertStmts, ...updateStmts];
    if (allStmts.length > 0) {
      await env.DB.batch(allStmts);
    }

    return ok({ imported: count });
  } catch (e: any) {
    return err(String(e.message || e), 500);
  }
}

