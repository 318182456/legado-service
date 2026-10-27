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
  try {
    const rows = id !== null
      ? [await env.DB.prepare("SELECT * FROM subscriptions WHERE id=?").bind(id).first()]
      : (await env.DB.prepare("SELECT * FROM subscriptions WHERE enabled=1").all()).results;
    if (id !== null && !rows[0]) return err("订阅不存在", 404);
    const manualUrls = new Set(["manual_sources", "manual_rules", "manual_txt_toc_rules", "manual_dict_rules"]);
    const items = rows.filter((sub: any) => !manualUrls.has(sub.url)) as any[];
    const summary = {
      total: rows.length, succeeded: 0, failed: 0, skipped: rows.length - items.length,
      failures: [] as { id: number; name: string; error: string }[],
    };
    const pending = new Set(items.map(sub => sub.id));
    const byId = new Map(items.map(sub => [sub.id, sub]));
    const fail = (sub: any, error: unknown) => {
      summary.failed++;
      summary.failures.push({ id: sub.id, name: sub.name || `订阅 #${sub.id}`, error: String(error).slice(0, 200) });
    };
    await runWorkerPool({
      taskType: "sync-subscriptions", items, threadCount: Math.min(4, items.length), concurrencyPerThread: 5,
      onResult: async msg => {
        const sub = byId.get(msg.id);
        if (!sub || !pending.delete(msg.id)) return;
        if (!msg.success) { fail(sub, msg.error || "抓取失败"); return; }
        try {
          if (sub.type === "source") await syncSourceSubscription(env, sub.id, sub.url, msg.rawItems);
          else if (sub.type === "rule") await syncRuleSubscription(env, sub.id, sub.url, msg.rawItems);
          else if (sub.type === "txtTocRule") await syncTxtTocRuleSubscription(env, sub.id, sub.url, msg.rawItems);
          else if (sub.type === "dictRule") await syncDictRuleSubscription(env, sub.id, sub.url, msg.rawItems);
          else throw new Error("不支持的订阅类型");
          summary.succeeded++;
        } catch (error) { fail(sub, error instanceof Error ? error.message : error); }
      },
    });
    for (const subId of pending) fail(byId.get(subId), "任务未完成，请重试");
    // 包含部分入库失败的情况：已经写入的数据仍需更新缓存。
    await Promise.all([
      rebuildCache(env, "source"), rebuildCache(env, "rule"),
      rebuildCache(env, "txtTocRule"), rebuildCache(env, "dictRule"),
    ]);
    return ok(summary);
  } catch (error) {
    return err(`同步发生异常: ${error instanceof Error ? error.message : String(error)}`, 500);
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

