import { sourceCheckOptions, persistSourceChecks, type SourceCheckRecord } from "../source-check";
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
import { purgeExpiredReviews, loadRetainDays } from "./reviews";

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
      "SELECT id, book_source_url, raw_json, updated_at FROM sources WHERE enabled = 1 ORDER BY last_checked ASC LIMIT 100"
    ).all();
    
    console.log(`Checking availability for ${sources.length} sources...`);

    if (sources.length > 0) {
      const verdicts: Record<number, CheckVerdict> = {};
      const records: SourceCheckRecord[] = [];
      const checkOptions = await sourceCheckOptions(env);
      await runWorkerPool({
        taskType: "test-sources",
        items: (sources as any[]).map(s => ({
          id: s.id,
          book_source_url: s.book_source_url,
          raw_json: s.raw_json, checkOptions
        })),
        threadCount: 2, concurrencyPerThread: 3,
        onResult: (msg) => {
          verdicts[msg.id] = msg.verdict || "skipped";
          records.push({ id: msg.id, verdict: verdicts[msg.id], reason: msg.reason || "task-error", detail: msg.detail, duration: msg.duration, version: (sources as any[]).find(s => s.id === msg.id)?.updated_at });
        }
      });

      await persistSourceChecks(env, records);

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

    // 4. 清掉过期的 AI 段评。读过的章节不会再回头看，
    // 留着只是让库越来越大、书目列表越来越长
    try {
      const retainDays = await loadRetainDays(env);
      if (retainDays > 0) await purgeExpiredReviews(env, retainDays);
      else console.log("Review purge disabled (review_retain_days=0)");
    } catch (e) {
      console.error("Review purge failed:", e);
    }

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
