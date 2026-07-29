import { Env } from "../types";
import {
  ensureDatabase,
  syncSourceSubscription,
  syncRuleSubscription,
  syncTxtTocRuleSubscription,
  syncDictRuleSubscription,
  rebuildCache,
} from "../utils";
import { runWorkerPool } from "./worker-runner";
import type { CheckVerdict } from "./worker-runner";

export async function handleScheduled(env: Env) {
  try {
    await ensureDatabase(env);
    console.log("Starting scheduled tasks...");

    // 1. 同步所有启用订阅（补全四种类型）
    const { results: subs } = await env.DB.prepare("SELECT * FROM subscriptions WHERE enabled = 1").all();
    for (const sub of subs as any[]) {
      try {
        console.log(`Syncing sub: ${sub.name} (${sub.url})`);
        if (sub.type === 'source') await syncSourceSubscription(env, sub.id, sub.url);
        else if (sub.type === 'rule') await syncRuleSubscription(env, sub.id, sub.url);
        else if (sub.type === 'txtTocRule') await syncTxtTocRuleSubscription(env, sub.id, sub.url);
        else if (sub.type === 'dictRule') await syncDictRuleSubscription(env, sub.id, sub.url);
      } catch (e) {
        console.error(`Sync failed for sub ${sub.id}:`, e);
      }
    }

    // 2. 检查书源可用性 — 并发请求 + batch 写入
    const { results: sources } = await env.DB.prepare(
      "SELECT id, book_source_url, raw_json FROM sources WHERE enabled = 1 ORDER BY last_checked ASC LIMIT 100"
    ).all();
    
    console.log(`Checking availability for ${sources.length} sources...`);

    if (sources.length > 0) {
      const verdicts: Record<number, CheckVerdict> = {};
      await runWorkerPool({
        taskType: "test-sources",
        items: (sources as any[]).map(s => ({
          id: s.id,
          book_source_url: s.book_source_url,
          raw_json: s.raw_json
        })),
        concurrencyPerThread: 10,
        onResult: (msg) => {
          verdicts[msg.id] = msg.verdict || "unavailable";
        }
      });

      // 无法判定的源保留上次的 is_available，只推进 last_checked，
      // 否则下一轮 ORDER BY last_checked 会一直重复挑中它们
      const stmts = (sources as any[]).map(src => {
        const verdict = verdicts[src.id];
        if (verdict === "skipped") {
          return env.DB.prepare(
            "UPDATE sources SET last_checked = datetime('now') WHERE id = ?"
          ).bind(src.id);
        }
        return env.DB.prepare(
          "UPDATE sources SET is_available = ?, last_checked = datetime('now') WHERE id = ?"
        ).bind(verdict === "available" ? 1 : 0, src.id);
      });
      await env.DB.batch(stmts);

      const counts = countVerdicts(sources as any[], verdicts);
      console.log(`Availability check done: available=${counts.available}, unavailable=${counts.unavailable}, skipped=${counts.skipped}`);
    }

    // 3. 重建全局 KV 缓存
    await Promise.all([
      rebuildCache(env, "source"),
      rebuildCache(env, "rule"),
      rebuildCache(env, "txtTocRule"),
      rebuildCache(env, "dictRule"),
    ]);

    console.log("Scheduled tasks completed.");
  } catch (e) {
    console.error("Scheduled handler error:", e);
  }
}

function countVerdicts(sources: any[], verdicts: Record<number, CheckVerdict>) {
  const counts = { available: 0, unavailable: 0, skipped: 0 };
  for (const src of sources) {
    const verdict = verdicts[src.id] || "unavailable";
    counts[verdict]++;
  }
  return counts;
}
