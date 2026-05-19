import { Env } from "../types";
import {
  ok,
  err,
  parseBody,
  rebuildCache,
} from "../utils";
import { runWorkerPool } from "./worker-runner";

let activeWorkers: any[] = [];

export async function handleListSources(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const filter = url.searchParams.get("filter") || "all";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = Math.max(5, Number(url.searchParams.get("limit") || "10"));
  const offset = (page - 1) * limit;

  console.log(`[ListSources] 查询书源列表: q="${q}", filter=${filter}, page=${page}, limit=${limit}`);

  let where = "name LIKE ?";
  const params: any[] = [`%${q}%`];

  if (filter === "available") {
    where += " AND is_available = 1";
  } else if (filter === "unavailable") {
    where += " AND is_available = 0";
  }

  const { results: sources } = await env.DB.prepare(
    `SELECT * FROM sources WHERE ${where} LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  const totalRow = (await env.DB.prepare(`SELECT COUNT(*) as count FROM sources WHERE ${where}`).bind(...params).first()) as any;
  const statsRow = (await env.DB.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN is_available=1 THEN 1 ELSE 0 END) as available FROM sources").first()) as any;

  return ok({
    sources,
    total: totalRow.count,
    totalPages: Math.ceil(totalRow.count / limit),
    stats: {
      total: statsRow.total || 0,
      available: statsRow.available || 0,
      unavailable: (statsRow.total || 0) - (statsRow.available || 0)
    },
    page,
    limit,
    hasMore: offset + sources.length < totalRow.count
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
    `SELECT id, COALESCE(test_url, book_source_url) as test_url FROM sources WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  const sourcesMap = new Map(rawSources.map((s: any) => [s.id, s]));
  const testResults: Record<number, boolean> = {};

  // 滑动窗口并发控制：最大并发 50
  const CONCURRENCY = 50;
  const pool: Promise<void>[] = [];

  for (const id of ids) {
    if (pool.length >= CONCURRENCY) {
      await Promise.race(pool);
    }

    const promise = (async () => {
      const sourceData = sourcesMap.get(id);
      if (!sourceData || !sourceData.test_url) {
        console.log(`[TestSources] 书源 ID ${id} 无有效测试 URL，跳过。`);
        testResults[id] = false; 
        return; 
      }

      const urlToTest = sourceData.test_url;
      const startTime = Date.now();

      const fetchOptions: RequestInit = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        signal: AbortSignal.timeout(5000) 
      };

      try {
        const res = await fetch(urlToTest, fetchOptions);
        await res.body?.cancel();
        const duration = Date.now() - startTime;
        const success = (res.status >= 200 && res.status < 400);
        testResults[id] = success;
        console.log(`[TestSources] 书源 ID ${id} 测试结果: ${success ? 'SUCCESS' : 'FAILED'} (状态: ${res.status}, 耗时: ${duration}ms)`);
      } catch (err: any) {
        const duration = Date.now() - startTime;
        testResults[id] = false;
        console.log(`[TestSources] 书源 ID ${id} 测试失败 (原因: ${err.message || err}, 耗时: ${duration}ms)`);
      }
    })();

    pool.push(promise);
    promise.finally(() => {
      const idx = pool.indexOf(promise);
      if (idx !== -1) pool.splice(idx, 1);
    });
  }

  await Promise.all(pool);

  // 批量更新数据库：将 50 个更新简化为批量 SQL 语句，大幅节省 CPU（不修改 enabled 状态）
  const availIds = ids.filter(id => testResults[id]);
  const unavailIds = ids.filter(id => !testResults[id]);

  const updateBatch = [];
  if (availIds.length > 0) {
    updateBatch.push(
      env.DB.prepare(
        `UPDATE sources SET is_available = 1, last_checked = datetime('now') WHERE id IN (${availIds.map(() => "?").join(",")})`
      ).bind(...availIds)
    );
  }
  if (unavailIds.length > 0) {
    updateBatch.push(
      env.DB.prepare(
        `UPDATE sources SET is_available = 0, last_checked = datetime('now') WHERE id IN (${unavailIds.map(() => "?").join(",")})`
      ).bind(...unavailIds)
    );
  }

  if (updateBatch.length > 0) {
    await env.DB.batch(updateBatch);
  }

  console.log(`[TestSources] 选中书源测试及数据库写入已完成。`);
  return ok(testResults);
}

export async function handleTestAllSources(env: Env, ctx: any): Promise<Response> {
  // 单次轻量级全量查询，获取全库所有书源 id 和测试 url（不限于启用的）
  const { results: rawSources } = await env.DB.prepare(
    "SELECT id, COALESCE(test_url, book_source_url) as test_url FROM sources"
  ).all();
  
  if (!rawSources.length) {
    console.log("[TestAllSources] 数据库中没有书源，无需测试。");
    return ok({ message: "No sources to test" });
  }

  const ids = rawSources.map((r: any) => r.id);
  const itemsToTest = rawSources.map((r: any) => ({
    id: r.id,
    urlToTest: r.test_url
  })).filter(x => x.urlToTest);

  console.log(`[TestAllSources] 触发后台全库测试，共发现 ${ids.length} 个书源 (有效测试链接 ${itemsToTest.length} 个)...`);

  const progressKey = "test_progress";
  const initialProgress = { current: 0, total: itemsToTest.length, running: true };
  await env.KV.put(progressKey, JSON.stringify(initialProgress));

  const runAllTests = async () => {
    try {
      let finishedCount = 0;
      const batchBuffer: { id: number; available: boolean }[] = [];
      let dbWritePromise = Promise.resolve();

      // 辅助函数：批量更新数据库与进度，采用链式 Promise 避免并发写入冲突
      const flushBatch = async () => {
        if (batchBuffer.length === 0) return;
        const toWrite = [...batchBuffer];
        batchBuffer.length = 0;

        dbWritePromise = dbWritePromise.then(async () => {
          const availIds = toWrite.filter(x => x.available).map(x => x.id);
          const unavailIds = toWrite.filter(x => !x.available).map(x => x.id);

          const updateBatch = [];
          if (availIds.length > 0) {
            updateBatch.push(
              env.DB.prepare(
                `UPDATE sources SET is_available = 1, last_checked = datetime('now') WHERE id IN (${availIds.map(() => "?").join(",")})`
              ).bind(...availIds)
            );
          }
          if (unavailIds.length > 0) {
            updateBatch.push(
              env.DB.prepare(
                `UPDATE sources SET is_available = 0, last_checked = datetime('now') WHERE id IN (${unavailIds.map(() => "?").join(",")})`
              ).bind(...unavailIds)
            );
          }

          if (updateBatch.length > 0) {
            await env.DB.batch(updateBatch);
          }

          // 平滑更新进度与打印日志
          finishedCount += toWrite.length;
          console.log(`[TestAllSources] 进度: ${finishedCount}/${itemsToTest.length}，本批写入: 可用 ${availIds.length} 个，不可用 ${unavailIds.length} 个`);

          const currentProgressRaw = await env.KV.get(progressKey);
          if (currentProgressRaw) {
            const currentProgress = JSON.parse(currentProgressRaw);
            if (currentProgress.running) {
              await env.KV.put(progressKey, JSON.stringify({
                current: Math.min(itemsToTest.length, finishedCount),
                total: itemsToTest.length,
                running: true
              }));
            }
          }
        }).catch(console.error);
      };

      // 启动共通多线程执行器
      await runWorkerPool({
        taskType: "test-sources",
        items: itemsToTest,
        threadCount: 4, // 使用 4 个工作线程
        concurrencyPerThread: 15, // 每个线程维持 15 个并发连接
        onResult: async (msg) => {
          // 检查是否已被手动中止
          const currentProgressRaw = await env.KV.get(progressKey);
          if (currentProgressRaw) {
            const currentProgress = JSON.parse(currentProgressRaw);
            if (!currentProgress.running) {
              // 被中止了，直接略过
              return;
            }
          }

          batchBuffer.push({ id: msg.id, available: msg.available });
          if (batchBuffer.length >= 50) {
            await flushBatch();
          }
        },
        onActiveWorkers: (workers) => {
          activeWorkers = workers;
        },
        onWorkerDone: (t) => {
          console.log(`[TestAllSources] 工作线程 ${t + 1} 已完成其分配的测试分片。`);
        }
      });

      // 写入剩余的测试结果
      await flushBatch();
      // 等待所有数据库写入工作最终闭合
      await dbWritePromise;

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

export async function handleParseLinks(url: URL): Promise<Response> {
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
    // 1. 标记失效书源：将 is_available = 0 的书源禁用，并归类到“失效”分组
    const markInvalidStmt = env.DB.prepare(`
      UPDATE sources
      SET enabled = 0,
          group_name = CASE
            WHEN group_name IS NULL OR group_name = '' THEN '失效'
            WHEN group_name LIKE '%失效%' THEN group_name
            ELSE group_name || ',失效'
          END
      WHERE is_available = 0
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


