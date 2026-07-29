import { Env } from "../types";
import {
  ok,
  err,
  parseBody,
  rebuildCache,
  hashText,
} from "../utils";
import { runWorkerPool } from "./worker-runner";
import type { CheckVerdict } from "./worker-runner";

let activeWorkers: any[] = [];

export async function handleListSources(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const filter = url.searchParams.get("filter") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = Math.max(5, Number(url.searchParams.get("limit") || "10"));
  const offset = (page - 1) * limit;
  const excludeDuplicate = url.searchParams.get("exclude_duplicate") === "true" || url.searchParams.get("exclude_duplicate") === "1";

  console.log(`[ListSources] 查询书源列表: q="${q}", filter=${filter}, excludeDuplicate=${excludeDuplicate}, page=${page}, limit=${limit}`);

  let where = "name LIKE ?";
  const params: any[] = [`%${q}%`];

  if (filter === "available") {
    where += " AND is_available = 1";
  } else if (filter === "unavailable") {
    where += " AND is_available = 0";
  } else if (filter === "need_login") {
    where += " AND (json_extract(raw_json, '$.loginUrl') IS NOT NULL AND json_extract(raw_json, '$.loginUrl') != '')";
  }

  if (excludeDuplicate) {
    where += " AND (group_name IS NULL OR group_name NOT LIKE '%重复%')";
  }

  // 用窗口函数将分页数据与总计数合并为 1 条查询（减少 1 次 DB 往返）
  const { results: sources } = await env.DB.prepare(
    `SELECT *, COUNT(*) OVER() as _total FROM sources WHERE ${where} LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  const total: number = (sources[0] as any)?._total ?? 0;
  // 去掉附加的内部字段，避免暴露给前端
  sources.forEach((s: any) => { delete s._total; });

  let statsQuery = "SELECT COUNT(*) as total, SUM(CASE WHEN is_available=1 THEN 1 ELSE 0 END) as available FROM sources";
  if (excludeDuplicate) {
    statsQuery += " WHERE (group_name IS NULL OR group_name NOT LIKE '%重复%')";
  }
  const statsRow = (await env.DB.prepare(statsQuery).first()) as any;

  return ok({
    sources,
    total,
    totalPages: Math.ceil(total / limit),
    stats: {
      total: statsRow.total || 0,
      available: statsRow.available || 0,
      unavailable: (statsRow.total || 0) - (statsRow.available || 0)
    },
    page,
    limit,
    hasMore: offset + sources.length < total
  });
}

export async function handleAllSourceIds(env: Env): Promise<Response> {
  console.log("[AllSourceIds] 查询所有书源的 ID 列表...");
  const { results } = await env.DB.prepare("SELECT id FROM sources").all();
  return ok(results.map((r: any) => r.id));
}

export async function handleTestSources(env: Env, request: Request, ctx: any): Promise<Response> {
  const body = await parseBody<{ ids: number[] }>(request);
  const ids = body?.ids || [];
  if (!ids.length) return ok({});

  console.log(`[TestSources] 开始测试选中的书源，共 ${ids.length} 个...`);

  const { results: rawSources } = await env.DB.prepare(
    `SELECT id, book_source_url, raw_json FROM sources WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  const sourcesMap = new Map(rawSources.map((s: any) => [s.id, s]));
  const verdicts: Record<number, CheckVerdict> = {};
  const reasons: Record<number, string> = {};

  // 库里查不到或没有配置内容的 id 无需入队，直接判失效
  const itemsToTest: any[] = [];
  for (const id of ids) {
    const sourceData = sourcesMap.get(id) as any;
    if (!sourceData || !sourceData.raw_json) {
      console.log(`[TestSources] 书源 ID ${id} 无有效配置，判定为不可用。`);
      verdicts[id] = "unavailable";
      reasons[id] = "missing-config";
      continue;
    }
    itemsToTest.push({
      id,
      book_source_url: sourceData.book_source_url,
      raw_json: sourceData.raw_json
    });
  }

  await runWorkerPool({
    taskType: "test-sources",
    items: itemsToTest,
    concurrencyPerThread: 15,
    onResult: (msg) => {
      verdicts[msg.id] = msg.verdict || "unavailable";
      reasons[msg.id] = msg.reason || "";
      const extra = msg.detail ? ` - ${msg.detail}` : "";
      console.log(`[TestSources] 书源 ID ${msg.id}: ${verdicts[msg.id]} (${msg.reason}${extra}, 耗时 ${msg.duration}ms)`);
    }
  });

  const counts = await writeVerdicts(env, ids, verdicts);

  console.log(`[TestSources] 测试完成：可用 ${counts.available}，不可用 ${counts.unavailable}，无法判定 ${counts.skipped}（保留原状态）。`);
  return ok({ verdicts, reasons, summary: counts });
}

/**
 * 按三态写回测试结果。
 * 无法判定（动态 JS 规则、限流、编码不支持）的源保留原有 is_available，
 * 只推进 last_checked —— 测不出来不等于失效，写 0 会误杀，写 1 会虚高。
 */
async function writeVerdicts(
  env: Env,
  ids: number[],
  verdicts: Record<number, CheckVerdict>
): Promise<{ available: number; unavailable: number; skipped: number }> {
  const availIds: number[] = [];
  const unavailIds: number[] = [];
  const skippedIds: number[] = [];

  for (const id of ids) {
    const verdict = verdicts[id];
    if (verdict === "available") availIds.push(id);
    else if (verdict === "skipped") skippedIds.push(id);
    else if (verdict === "unavailable") unavailIds.push(id);
  }

  const holders = (n: number) => Array.from({ length: n }, () => "?").join(",");
  const updateBatch: any[] = [];

  if (availIds.length > 0) {
    updateBatch.push(
      env.DB.prepare(
        `UPDATE sources SET is_available = 1, last_checked = datetime('now') WHERE id IN (${holders(availIds.length)})`
      ).bind(...availIds)
    );
  }
  if (unavailIds.length > 0) {
    updateBatch.push(
      env.DB.prepare(
        `UPDATE sources SET is_available = 0, last_checked = datetime('now') WHERE id IN (${holders(unavailIds.length)})`
      ).bind(...unavailIds)
    );
  }
  if (skippedIds.length > 0) {
    updateBatch.push(
      env.DB.prepare(
        `UPDATE sources SET last_checked = datetime('now') WHERE id IN (${holders(skippedIds.length)})`
      ).bind(...skippedIds)
    );
  }

  if (updateBatch.length > 0) {
    await env.DB.batch(updateBatch);
  }

  return {
    available: availIds.length,
    unavailable: unavailIds.length,
    skipped: skippedIds.length
  };
}

export async function handleTestAllSources(env: Env, ctx: any): Promise<Response> {
  // 获取全库所有书源 id、book_source_url 和 raw_json（不限于启用的）
  const { results: rawSources } = await env.DB.prepare(
    "SELECT id, book_source_url, raw_json FROM sources"
  ).all();
  
  if (!rawSources.length) {
    console.log("[TestAllSources] 数据库中没有书源，无需测试。");
    return ok({ message: "No sources to test" });
  }

  const ids = rawSources.map((r: any) => r.id);
  const itemsToTest = rawSources.map((r: any) => ({
    id: r.id,
    book_source_url: r.book_source_url,
    raw_json: r.raw_json
  }));

  console.log(`[TestAllSources] 触发后台全库测试，共发现 ${ids.length} 个书源...`);

  const progressKey = "test_progress";
  const initialProgress = { current: 0, total: itemsToTest.length, running: true };
  await env.KV.put(progressKey, JSON.stringify(initialProgress));

  const runAllTests = async () => {
    try {
      let finishedCount = 0;
      let aborted = false;
      const batchBuffer: { id: number; verdict: CheckVerdict }[] = [];
      const reasonTally: Record<string, number> = {};
      let dbWritePromise = Promise.resolve();

      // 辅助函数：批量更新数据库与进度，采用链式 Promise 避免并发写入冲突
      const flushBatch = async () => {
        if (batchBuffer.length === 0) return;
        const toWrite = batchBuffer.splice(0, batchBuffer.length);

        dbWritePromise = dbWritePromise.then(async () => {
          if (aborted) return;
          // 每批写入前确认一次是否被中止，而不是每条结果都去读一次 KV
          if (!(await isTestRunning(env, progressKey))) {
            aborted = true;
            return;
          }

          const verdicts: Record<number, CheckVerdict> = {};
          for (const item of toWrite) verdicts[item.id] = item.verdict;
          const counts = await writeVerdicts(env, toWrite.map(x => x.id), verdicts);

          finishedCount += toWrite.length;
          console.log(`[TestAllSources] 进度: ${finishedCount}/${itemsToTest.length}，本批可用 ${counts.available}，不可用 ${counts.unavailable}，无法判定 ${counts.skipped}`);

          await env.KV.put(progressKey, JSON.stringify({
            current: Math.min(itemsToTest.length, finishedCount),
            total: itemsToTest.length,
            running: true
          }));
        }).catch(console.error);
      };

      // 启动共通多线程执行器
      await runWorkerPool({
        taskType: "test-sources",
        items: itemsToTest,
        threadCount: 4, // 使用 4 个工作线程
        concurrencyPerThread: 15, // 每个线程维持 15 个并发连接
        onResult: (msg) => {
          if (aborted) return;
          batchBuffer.push({ id: msg.id, verdict: msg.verdict || "unavailable" });
          if (msg.reason) reasonTally[msg.reason] = (reasonTally[msg.reason] || 0) + 1;
          // onResult 由线程池串行调用，缓冲区不会被并发进入
          if (batchBuffer.length >= 50) return flushBatch();
        },
        onActiveWorkers: (workers) => {
          activeWorkers = workers;
        },
        onWorkerDone: (t) => {
          console.log(`[TestAllSources] 工作线程 ${t + 1} 已完成任务。`);
        }
      });

      // 写入剩余的测试结果
      await flushBatch();
      // 等待所有数据库写入工作最终闭合
      await dbWritePromise;

      const tally = Object.entries(reasonTally)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ");
      console.log(`[TestAllSources] 判定原因分布: ${tally || "无"}`);

      // 测试完毕，更新状态为未运行，并自动重建缓存
      const finalProgressRaw = await env.KV.get(progressKey);
      if (finalProgressRaw) {
        const finalProgress = JSON.parse(finalProgressRaw);
        if (finalProgress.running) {
          await rebuildCache(env, "source");
        }
      }
      await env.KV.put(progressKey, JSON.stringify({ current: 0, total: 0, running: false }));
      console.log("[TestAllSources] 后台多线程全库健康测试与缓存重建圆满完成。");
      activeWorkers = [];
    } catch (err) {
      console.error("[TestAllSources] 后台多线程测试发生异常:", err);
      await env.KV.put(progressKey, JSON.stringify({ current: 0, total: 0, running: false }));
      activeWorkers = [];
    }
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(runAllTests());
  } else {
    runAllTests().catch(console.error);
  }

  return ok({ message: "Test started in background using multi-threading" });
}

/** 全库测试是否仍在进行（未被 handleStopTestSources 中止） */
async function isTestRunning(env: Env, progressKey: string): Promise<boolean> {
  try {
    const raw = await env.KV.get(progressKey);
    if (!raw) return false;
    return JSON.parse(raw).running === true;
  } catch (_) {
    return false;
  }
}

export async function handleStopTestSources(env: Env): Promise<Response> {
  console.log("[TestSources] 收到中止测试指令，正在销毁所有活跃的工作线程并重置状态...");
  if (activeWorkers.length > 0) {
    for (const worker of activeWorkers) {
      try {
        worker.terminate().catch(() => {});
      } catch (_) {}
    }
    activeWorkers = [];
  }
  const progressKey = "test_progress";
  await env.KV.put(progressKey, JSON.stringify({ current: 0, total: 0, running: false }));
  return ok();
}

export async function handleGetTestProgress(env: Env): Promise<Response> {
  const progressKey = "test_progress";
  const progressRaw = await env.KV.get(progressKey);
  if (progressRaw) {
    return ok(JSON.parse(progressRaw));
  }
  return ok({ current: 0, total: 0, running: false });
}

export async function handleSourceAction(env: Env, id: number, action: string, request?: Request): Promise<Response> {
  console.log(`[SourceAction] 触发书源动作: action="${action}", ID=${id}`);
  if (action === "delete") {
    await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(id).run();
    console.log(`[SourceAction] 书源 ID ${id} 已成功从数据库中删除`);
  } else if (action === "delete-all") {
    await env.DB.prepare("DELETE FROM sources").run();
    console.log("[SourceAction] 已成功清空所有书源数据");
  } else if (action === "toggle" && request) {
    const { enabled } = await request.json() as { enabled: number };
    await env.DB.prepare("UPDATE sources SET enabled = ? WHERE id = ?").bind(enabled, id).run();
    console.log(`[SourceAction] 书源 ID ${id} 的启用状态已变更为: ${enabled === 1 ? "启用" : "禁用"}`);
  }
  return ok();
}

export async function handleParseLinks(env: Env, url: URL): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) return err("url 不能为空");

  console.log(`[ParseLinks] 开始解析目标网页中的书源导入链接: ${targetUrl}`);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(targetUrl, {
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.log(`[ParseLinks] 解析失败，目标网页返回错误状态码: ${res.status}`);
      return err(`目标网页返回错误: ${res.status}`);
    }
    const html = await res.text();
    
    const results: { name: string; url: string; type: "source" | "rule" }[] = [];
    const linkRegex = /(?:(importBookSource[s]?|importReplaceRule[s]?)\?src=|src=)([^"& '"]+)/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      const subUrl = decodeURIComponent(match[2]).replace(/['"]$/, '');
      if (!subUrl.startsWith('http')) continue;

      const matchIndex = match.index;
      const searchRange = html.substring(Math.max(0, matchIndex - 1000), matchIndex);
      
      const titlePatterns = [
        /<(h[1-6]|div)[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi,
        /<(h[1-6])>([\s\S]*?)<\/\1>/gi,
        /<div[^>]*class="aui-flex-box"[^>]*>([\s\S]*?)<\/div>/gi
      ];

      let bestName = "";
      for (const pattern of titlePatterns) {
        let tMatch;
        let lastMatchText = "";
        while ((tMatch = pattern.exec(searchRange)) !== null) {
          lastMatchText = tMatch[tMatch.length - 1].replace(/<[^>]+>/g, '').trim();
        }
        if (lastMatchText) {
          bestName = lastMatchText;
        }
      }

      if (!bestName) {
        const linkTag = html.substring(matchIndex - 50, matchIndex + 200);
        const titleAttr = /title="([^"]+)"/.exec(linkTag);
        if (titleAttr) bestName = titleAttr[1];
      }

      let name = (bestName && bestName !== "一键导入") ? bestName : "未知来源";
      
      name = name
        .replace(/\d{4}年\d{1,2}月\d{1,2}日更新/g, '')
        .replace(/\d{4}年\d{1,2}月\d{1,2}日/g, '')
        .replace(/\d+个/g, '')
        .replace(/更新/g, '')
        .replace(/合集/g, '')
        .replace(/【[^\]]+】/g, '')
        .replace(/\[[^\]]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!name) name = "未知来源";

      let type: "source" | "rule" = "source";
      if (match[1]) {
        const lowerImportType = match[1].toLowerCase();
        if (lowerImportType.includes("replace") || lowerImportType.includes("rule")) {
          type = "rule";
        }
      } else {
        const lowerUrl = subUrl.toLowerCase();
        const lowerName = name.toLowerCase();
        if (
          lowerUrl.includes("replace") || 
          lowerUrl.includes("rule") || 
          lowerName.includes("净化") || 
          lowerName.includes("规则")
        ) {
          type = "rule";
        }
      }
      
      if (!results.find(r => r.url === subUrl)) {
        results.push({ name, url: subUrl, type });
      }
    }

    console.log(`[ParseLinks] 解析成功，在目标网页中共抽取出 ${results.length} 个有效的导入链接`);
    try {
      await env.DB.prepare(
        `INSERT INTO parse_history (url, updated_at) VALUES (?, datetime('now'))
         ON CONFLICT(url) DO UPDATE SET updated_at = datetime('now')`
      ).bind(targetUrl).run();
    } catch (dbErr) {
      console.error("[ParseLinks] 写入解析历史至数据库失败:", dbErr);
    }
    return ok(results);
  } catch (e) {
    const isTimeout = (e as Error).name === 'AbortError';
    console.log(`[ParseLinks] 解析异常: ${isTimeout ? '请求超时 (15s)' : (e as Error).message}`);
    return err(isTimeout ? "请求超时，目标网站响应过慢" : `解析失败: ${(e as Error).message}`, 500);
  }
}

export async function handleStats(env: Env): Promise<Response> {
  console.log("[Stats] 正在统计系统中的有效订阅、书源与规则数量...");
  const subRow = (await env.DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN type='source' THEN 1 ELSE 0 END) as sources, SUM(CASE WHEN type='rule' THEN 1 ELSE 0 END) as rules FROM subscriptions WHERE enabled=1").first()) as any;
  const srcRow = (await env.DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN is_available=1 THEN 1 ELSE 0 END) as available FROM sources WHERE enabled=1").first()) as any;
  const ruleRow = (await env.DB.prepare("SELECT COUNT(*) as total FROM rules WHERE enabled=1").first()) as any;
  console.log(`[Stats] 统计完成: 订阅总数=${subRow.total} (书源=${subRow.sources || 0}, 规则=${subRow.rules || 0})，启用书源数=${srcRow.total} (可用=${srcRow.available || 0})，启用规则数=${ruleRow.total}`);
  return ok({ subscriptions: subRow, sources: srcRow, rules: ruleRow });
}

export async function handleCleanupSources(env: Env): Promise<Response> {
  console.log("[CleanupSources] 开始标记失效与重复书源...");
  try {
    // 1. 标记失效书源：将 is_available = 0 或需要登录（含有非空 loginUrl）的书源禁用，并归类到“失效”分组
    const markInvalidStmt = env.DB.prepare(`
      UPDATE sources
      SET enabled = 0,
          group_name = CASE
            WHEN group_name IS NULL OR group_name = '' THEN '失效'
            WHEN group_name LIKE '%失效%' THEN group_name
            ELSE group_name || ',失效'
          END
      WHERE is_available = 0 
         OR (json_extract(raw_json, '$.loginUrl') IS NOT NULL AND json_extract(raw_json, '$.loginUrl') != '')
    `);

    // 2. 标记重复书源：使用窗口函数对相同 url_hash 的书源进行排序
    //    保留优先级最高的项（rn = 1），将其余项禁用并归类到“重复”分组
    const markDuplicateStmt = env.DB.prepare(`
      WITH ranked_sources AS (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY url_hash
          ORDER BY enabled DESC, is_available DESC, updated_at DESC, id DESC
        ) as rn
        FROM sources
        WHERE url_hash IS NOT NULL AND url_hash != ''
      )
      UPDATE sources
      SET enabled = 0,
          group_name = CASE
            WHEN group_name IS NULL OR group_name = '' THEN '重复'
            WHEN group_name LIKE '%重复%' THEN group_name
            ELSE group_name || ',重复'
          END
      WHERE id IN (SELECT id FROM ranked_sources WHERE rn > 1)
    `);

    // 批量执行
    const batchRes = await env.DB.batch([markInvalidStmt, markDuplicateStmt]);
    const markedInvalid = batchRes[0]?.meta?.changes ?? 0;
    const markedDuplicates = batchRes[1]?.meta?.changes ?? 0;

    console.log(`[CleanupSources] 标记完成: 禁用并归类失效书源 ${markedInvalid} 个，重复书源 ${markedDuplicates} 个`);

    // 3. 重新构建全局书源 KV 缓存
    console.log("[CleanupSources] 正在重新构建全局书源缓存...");
    await rebuildCache(env, "source");

    return ok({ markedInvalid, markedDuplicates });
  } catch (e: any) {
    console.error("[CleanupSources] 标记清理发生异常:", e);
    return err(`标记清理失败: ${e.message || e}`, 500);
  }
}

export async function handleImportSources(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ sources: any[] }>(request);
  const sourcesArray = body?.sources;
  if (!Array.isArray(sourcesArray) || sourcesArray.length === 0) return err("无有效书源数据");

  let manualSub = (await env.DB.prepare("SELECT id FROM subscriptions WHERE url = 'manual_sources'").first()) as any;
  if (!manualSub) {
    const { meta } = await env.DB.prepare("INSERT INTO subscriptions (name, url, type) VALUES ('手动添加书源', 'manual_sources', 'source')").run();
    manualSub = { id: meta.last_row_id };
  }

  const subId = manualSub.id;
  let count = 0;
  const BATCH = 50;

  for (let i = 0; i < sourcesArray.length; i += BATCH) {
    const chunk = sourcesArray.slice(i, i + BATCH);
    const stmts = chunk.map(async (src) => {
      const bsUrl = String(src.bookSourceUrl ?? src.sourceUrl ?? "").trim();
      const name = String(src.bookSourceName ?? src.name ?? "未知书源").trim();
      if (!bsUrl || !name) return null;

      const group = String(src.bookSourceGroup ?? src.group ?? "");
      const rawJson = JSON.stringify(src);
      
      let testUrl = bsUrl;
      try {
        const searchUrl = src.searchUrl;
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

      const urlHash = await hashText(bsUrl);

      return env.DB.prepare(
        `INSERT INTO sources (subscription_id, book_source_url, name, group_name, raw_json, test_url, url_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(subscription_id, url_hash)
         DO UPDATE SET name=excluded.name, group_name=excluded.group_name,
                       raw_json=excluded.raw_json, test_url=excluded.test_url, updated_at=excluded.updated_at`
      ).bind(subId, bsUrl, name, group, rawJson, testUrl, urlHash);
    });

    const resolvedStmts = (await Promise.all(stmts)).filter(x => x !== null) as any[];
    if (resolvedStmts.length > 0) {
      await env.DB.batch(resolvedStmts);
      count += resolvedStmts.length;
    }
  }

  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=(SELECT COUNT(*) FROM sources WHERE subscription_id=?) WHERE id=?`
  ).bind(subId, subId).run();

  await rebuildCache(env, "source");
  return ok({ imported: count });
}

export async function handleListParseHistory(env: Env): Promise<Response> {
  console.log("[ListParseHistory] 获取网页解析历史记录...");
  try {
    const { results } = await env.DB.prepare(
      "SELECT url FROM parse_history ORDER BY updated_at DESC LIMIT 10"
    ).all();
    return ok(results.map((r: any) => r.url));
  } catch (e) {
    console.error("[ListParseHistory] 获取解析历史失败:", e);
    return err(`获取解析历史失败: ${(e as Error).message}`, 500);
  }
}

export async function handleDeleteParseHistory(env: Env, url: URL): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  try {
    if (targetUrl) {
      console.log(`[DeleteParseHistory] 删除指定历史记录: ${targetUrl}`);
      await env.DB.prepare("DELETE FROM parse_history WHERE url = ?").bind(targetUrl).run();
    } else {
      console.log("[DeleteParseHistory] 清空所有历史记录...");
      await env.DB.prepare("DELETE FROM parse_history").run();
    }
    return ok();
  } catch (e) {
    console.error("[DeleteParseHistory] 删除解析历史失败:", e);
    return err(`删除解析历史失败: ${(e as Error).message}`, 500);
  }
}



