import { Env } from "../types";
import {
  ensureDatabase,
  syncSourceSubscription,
  syncRuleSubscription,
} from "../utils";

export async function handleScheduled(env: Env) {
  try {
    await ensureDatabase(env);
    console.log("Starting scheduled tasks...");

    // 1. 同步所有启用订阅
    const { results: subs } = await env.DB.prepare("SELECT * FROM subscriptions WHERE enabled = 1").all();
    for (const sub of subs as any[]) {
      try {
        console.log(`Syncing sub: ${sub.name} (${sub.url})`);
        if (sub.type === 'source') await syncSourceSubscription(env, sub.id, sub.url);
        else await syncRuleSubscription(env, sub.id, sub.url);
      } catch (e) {
        console.error(`Sync failed for sub ${sub.id}:`, e);
      }
    }

    // 2. 检查书源可用性 — 并发请求 + batch 写入
    const { results: sources } = await env.DB.prepare(
      "SELECT id, book_source_url FROM sources WHERE enabled = 1 ORDER BY last_checked ASC LIMIT 100"
    ).all();
    
    console.log(`Checking availability for ${sources.length} sources...`);

    const checkResults: Record<number, boolean> = {};
    await Promise.all((sources as any[]).map(async (src) => {
      try {
        const res = await fetch(src.book_source_url, { 
          method: 'HEAD', 
          headers: { 'User-Agent': 'Mozilla/5.0 Legado-Check/1.0' },
          signal: AbortSignal.timeout(3000)
        });
        checkResults[src.id] = res.ok;
      } catch (e) {
        checkResults[src.id] = false;
      }
    }));

    if (sources.length > 0) {
      const stmts = (sources as any[]).map(src => {
        const avail = checkResults[src.id] ? 1 : 0;
        return env.DB.prepare(
          "UPDATE sources SET is_available = ?, last_checked = datetime('now') WHERE id = ?"
        ).bind(avail, src.id);
      });
      await env.DB.batch(stmts);
    }
    
    console.log("Scheduled tasks completed.");
  } catch (e) {
    console.error("Scheduled handler error:", e);
  }
}
