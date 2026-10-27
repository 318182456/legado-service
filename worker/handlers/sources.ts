import { sourceCheckOptions, persistSourceChecks, type SourceCheckRecord } from "../source-check";
import { readPage, positiveInteger } from "../pagination";
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
let activeTestId = "";

export async function handleListSources(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const filter = url.searchParams.get("filter") || "all";
  const requestedPage = positiveInteger(url.searchParams.get("page"), 1);
  const limit = Math.max(5, positiveInteger(url.searchParams.get("limit"), 10, 100));
  const excludeDuplicate = url.searchParams.get("exclude_duplicate") === "true" || url.searchParams.get("exclude_duplicate") === "1";

  console.log(`[ListSources] 查询书源列表: q="${q}", filter=${filter}, excludeDuplicate=${excludeDuplicate}, page=${requestedPage}, limit=${limit}`);

  let where = "name LIKE ?";
  const params: any[] = [`%${q}%`];

  if (filter === "available") {
    where += " AND id IN (SELECT c.source_id FROM source_checks c JOIN sources current ON current.id = c.source_id AND current.updated_at = c.source_updated_at WHERE verdict = 'available')";
  } else if (filter === "unavailable") {
    where += " AND id IN (SELECT c.source_id FROM source_checks c JOIN sources current ON current.id = c.source_id AND current.updated_at = c.source_updated_at WHERE verdict = 'unavailable')";
  } else if (filter === "skipped") {
    where += " AND id IN (SELECT c.source_id FROM source_checks c JOIN sources current ON current.id = c.source_id AND current.updated_at = c.source_updated_at WHERE verdict = 'skipped')";
  } else if (filter === "unchecked") {
    where += " AND id NOT IN (SELECT c.source_id FROM source_checks c JOIN sources current ON current.id = c.source_id AND current.updated_at = c.source_updated_at)";
  } else if (filter === "need_login") {
    where += " AND (json_extract(raw_json, '$.loginUrl') IS NOT NULL AND json_extract(raw_json, '$.loginUrl') != '')";
  }

  if (excludeDuplicate) {
    where += " AND (group_name IS NULL OR group_name NOT LIKE '%重复%')";
  }

  const { results: sources, ...pagination } = await readPage(env, {
    table: "sources", where, params, orderBy: "id DESC", page: requestedPage, limit,
  });

  if (sources.length) {
    const { results: checks } = await env.DB.prepare(`SELECT * FROM source_checks WHERE source_updated_at = (SELECT updated_at FROM sources WHERE sources.id = source_checks.source_id) AND source_id IN (${sources.map(() => '?').join(',')})`).bind(...sources.map(s => s.id)).all();
    const byId = new Map(checks.map(c => [c.source_id, c]));
    for (const source of sources) {
      const check = byId.get(source.id);
      if (check) Object.assign(source, { check_verdict: check.verdict, check_reason: check.reason, check_detail: check.detail, check_duration: check.duration });
    }
  }
  let statsQuery = `SELECT COUNT(*) AS total,
    SUM(CASE WHEN c.verdict = 'available' THEN 1 ELSE 0 END) AS available,
    SUM(CASE WHEN c.verdict = 'unavailable' THEN 1 ELSE 0 END) AS unavailable
    FROM sources s LEFT JOIN source_checks c ON c.source_id = s.id AND c.source_updated_at = s.updated_at`;
  if (excludeDuplicate) statsQuery += " WHERE (s.group_name IS NULL OR s.group_name NOT LIKE '%重复%')";
  const stats = await env.DB.prepare(statsQuery).first();
  const total = Number(stats?.total || 0), available = Number(stats?.available || 0), unavailable = Number(stats?.unavailable || 0);
  return ok({ sources, ...pagination, stats: { total, available, unavailable, unchecked: total - available - unavailable } });
}

export async function handleAllSourceIds(env: Env): Promise<Response> {
  console.log("[AllSourceIds] 查询所有书源的 ID 列表...");
  const { results } = await env.DB.prepare("SELECT id FROM sources").all();
  return ok(results.map((r: any) => r.id));
}

export async function handleTestSources(env: Env, request: Request, ctx: any): Promise<Response> {
  const body = await parseBody<{ ids: number[]; depth?: 'search' | 'content' }>(request);
  if (!Array.isArray(body?.ids) || body.ids.length > 200) return err("请选择 1~200 个书源");
  let ids = [...new Set(body.ids.filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return err("请选择有效的书源");
  const checkOptions = await sourceCheckOptions(env, body.depth === 'content' ? 'content' : 'search');

  console.log(`[TestSources] 开始测试选中的书源，共 ${ids.length} 个...`);

  const { results: rawSources } = await env.DB.prepare(
    `SELECT id, book_source_url, raw_json, updated_at FROM sources WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();

  const sourcesMap = new Map(rawSources.map((s: any) => [s.id, s]));
  ids = ids.filter(id => sourcesMap.has(id));
  const records: SourceCheckRecord[] = [];
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
      records.push({ id, verdict: "unavailable", reason: "missing-config", detail: "缺少书源配置", version: sourceData?.updated_at });
      continue;
    }
    itemsToTest.push({
      id,
      book_source_url: sourceData.book_source_url,
      raw_json: sourceData.raw_json,
      checkOptions
    });
  }

  await runWorkerPool({
    taskType: "test-sources",
    items: itemsToTest,
    threadCount: 2, concurrencyPerThread: 3,
    onResult: (msg) => {
      verdicts[msg.id] = msg.verdict || "skipped";
      records.push({ id: msg.id, verdict: verdicts[msg.id], reason: msg.reason || "task-error", detail: msg.detail, duration: msg.duration, version: sourcesMap.get(msg.id)?.updated_at });
      reasons[msg.id] = msg.reason || "";
      const extra = msg.detail ? ` - ${msg.detail}` : "";
      console.log(`[TestSources] 书源 ID ${msg.id}: ${verdicts[msg.id]} (${msg.reason}${extra}, 耗时 ${msg.duration}ms)`);
    }
  });

  const counts = await persistSourceChecks(env, records);
  if (records.some(r => r.reason === "login-required" || r.reason === "login-redirect")) await rebuildCache(env, "source");

  console.log(`[TestSources] 测试完成：可用 ${counts.available}，不可用 ${counts.unavailable}，无法判定 ${counts.skipped}（保留原状态）。`);
  return ok({ verdicts, reasons, summary: counts });
}

export async function handleTestAllSources(env: Env, ctx: any, depth: 'search' | 'content' = 'search'): Promise<Response> {
  if (activeTestId || await isTestRunning(env, "test_progress")) return err("全库测试正在进行，请等待完成或先停止", 409);
  // 获取全库所有书源 id、book_source_url 和 raw_json（不限于启用的）
  const { results: rawSources } = await env.DB.prepare(
    "SELECT id, book_source_url, raw_json, updated_at FROM sources"
  ).all();
  
  if (!rawSources.length) {
    console.log("[TestAllSources] 数据库中没有书源，无需测试。");
    return ok({ started: false, total: 0 });
  }

  const checkOptions = await sourceCheckOptions(env, depth);
  const ids = rawSources.map((r: any) => r.id);
  const sourceVersions = new Map(rawSources.map(r => [r.id, r.updated_at]));
  const itemsToTest = rawSources.map((r: any) => ({
    id: r.id,
    book_source_url: r.book_source_url,
    raw_json: r.raw_json, checkOptions
  }));

  console.log(`[TestAllSources] 触发后台全库测试，共发现 ${ids.length} 个书源...`);

  const progressKey = "test_progress";
  if (activeTestId) return err("全库测试正在启动，请稍后再试", 409);
  const runId = crypto.randomUUID();
  activeTestId = runId;
  const initialProgress = { current: 0, total: itemsToTest.length, running: true, status: "running", runId };
  try { await env.KV.put(progressKey, JSON.stringify(initialProgress)); }
  catch (error) { activeTestId = ""; throw error; }

  const runAllTests = async () => {
    let cacheDirty = false;
    try {
      let finishedCount = 0;
      let aborted = false;
      const batchBuffer: SourceCheckRecord[] = [];
      const reasonTally: Record<string, number> = {};
      let dbWritePromise = Promise.resolve();
      let writeError: unknown;

      // 辅助函数：批量更新数据库与进度，采用链式 Promise 避免并发写入冲突
      const flushBatch = async () => {
        if (batchBuffer.length === 0) return;
        const toWrite = batchBuffer.splice(0, batchBuffer.length);

        dbWritePromise = dbWritePromise.then(async () => {
          if (aborted) return;
          // 每批写入前确认一次是否被中止，而不是每条结果都去读一次 KV
          if (!(await isTestRunning(env, progressKey, runId))) {
            aborted = true;
            return;
          }

          const counts = await persistSourceChecks(env, toWrite);
          cacheDirty ||= toWrite.some(row => row.reason === "login-required" || row.reason === "login-redirect");

          finishedCount += toWrite.length;
          console.log(`[TestAllSources] 进度: ${finishedCount}/${itemsToTest.length}，本批可用 ${counts.available}，不可用 ${counts.unavailable}，无法判定 ${counts.skipped}`);

          if (!(await isTestRunning(env, progressKey, runId))) { aborted = true; return; }
          await env.KV.put(progressKey, JSON.stringify({
            current: Math.min(itemsToTest.length, finishedCount),
            total: itemsToTest.length,
            running: true, status: "running", runId
          }));
        }).catch(error => { writeError = error; aborted = true; });
      };

      // 启动共通多线程执行器
      await runWorkerPool({
        taskType: "test-sources",
        items: itemsToTest,
        threadCount: 2,
        concurrencyPerThread: 3, // reader 检测全局最多 6 个，避免并发过大造成限流误判
        onResult: (msg) => {
          if (aborted) return;
          batchBuffer.push({ id: msg.id, verdict: msg.verdict || "skipped", reason: msg.reason || "task-error", detail: msg.detail, duration: msg.duration, version: sourceVersions.get(msg.id) });
          if (msg.reason) reasonTally[msg.reason] = (reasonTally[msg.reason] || 0) + 1;
          // onResult 由线程池串行调用，缓冲区不会被并发进入
          if (batchBuffer.length >= 50) return flushBatch();
        },
        onActiveWorkers: (workers) => {
          if (activeTestId === runId) activeWorkers = workers;
          else for (const worker of workers) void worker.terminate().catch(() => {});
        },
        onWorkerDone: (t) => {
          console.log(`[TestAllSources] 工作线程 ${t + 1} 已完成任务。`);
        }
      });

      // 写入剩余的测试结果
      await flushBatch();
      // 等待所有数据库写入工作最终闭合
      await dbWritePromise;
      if (writeError) throw writeError;

      const tally = Object.entries(reasonTally)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ");
      console.log(`[TestAllSources] 判定原因分布: ${tally || "无"}`);

      // 只结束本次任务，停止或新任务开始后旧任务不能覆盖进度。
      if (await isTestRunning(env, progressKey, runId)) {
        await rebuildCache(env, "source");
        cacheDirty = false;
        if (await isTestRunning(env, progressKey, runId)) {
          await env.KV.put(progressKey, JSON.stringify({ current: finishedCount, total: itemsToTest.length, running: false, status: "completed", runId }));
        }
      }
    } catch (error) {
      console.error("[TestAllSources] 后台测试失败:", error);
      if (await isTestRunning(env, progressKey, runId)) {
        await env.KV.put(progressKey, JSON.stringify({ current: 0, total: itemsToTest.length, running: false, status: "failed", runId }));
      }
    } finally {
      if (cacheDirty) await rebuildCache(env, "source").catch(error => console.error("[TestAllSources] 禁用书源后的缓存重建失败", error));
      if (activeTestId === runId) { activeWorkers = []; activeTestId = ""; }
    }
  };

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(runAllTests());
  } else {
    runAllTests().catch(console.error);
  }

  return ok({ started: true, total: itemsToTest.length });
}

/** 全库测试是否仍在进行（未被 handleStopTestSources 中止） */
async function isTestRunning(env: Env, progressKey: string, runId?: string): Promise<boolean> {
  try {
    const raw = await env.KV.get(progressKey);
    if (!raw) return false;
    const progress = JSON.parse(raw);
    return progress.running === true && (!runId || progress.runId === runId);
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
  activeTestId = "";
  const progressKey = "test_progress";
  const raw = await env.KV.get(progressKey);
  const progress = raw ? JSON.parse(raw) : { current: 0, total: 0 };
  await env.KV.put(progressKey, JSON.stringify({ ...progress, running: false, status: "stopped" }));
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
      WHERE id IN (SELECT c.source_id FROM source_checks c JOIN sources current ON current.id = c.source_id AND current.updated_at = c.source_updated_at WHERE verdict = 'unavailable')
        AND (group_name IS NULL OR group_name NOT LIKE '%失效%' OR enabled != 0)
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
        AND (group_name IS NULL OR group_name NOT LIKE '%重复%' OR enabled != 0)
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



