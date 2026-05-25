import { fileURLToPath } from "url";
import os from "os";

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


let WorkerClass: any = null;
let isMain = true;
let pPort: any = null;
let wData: any = null;

if (typeof process !== "undefined" && process.versions && process.versions.node) {
  try {
    const wt = await import("worker_threads");
    WorkerClass = wt.Worker;
    isMain = wt.isMainThread;
    pPort = wt.parentPort;
    wData = wt.workerData;
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────
// 1. 子线程工作逻辑 (Worker Execution Block)
// ─────────────────────────────────────────────────────────────────────
if (!isMain && pPort && wData) {
  const { taskType, chunk, concurrency } = wData;

  const run = async () => {
    if (taskType === "test-sources") {
      // 全库书源健康测试任务
      const pool: Promise<void>[] = [];
      for (const source of chunk) {
        if (pool.length >= concurrency) {
          await Promise.race(pool);
        }

        const promise = (async () => {
          const startTime = Date.now();
          try {
            const success = await checkBookSourceRealAvailability(source.raw_json, source.book_source_url);
            const duration = Date.now() - startTime;
            pPort!.postMessage({
              type: "result",
              id: source.id,
              available: success,
              duration
            });
          } catch (err: any) {
            const duration = Date.now() - startTime;
            pPort!.postMessage({
              type: "result",
              id: source.id,
              available: false,
              error: err.message || err,
              duration
            });
          }
        })();

        pool.push(promise);
        promise.finally(() => {
          const idx = pool.indexOf(promise);
          if (idx !== -1) pool.splice(idx, 1);
        });
      }
      await Promise.all(pool);
      pPort!.postMessage({ type: "done" });
      process.exit(0);

    } else if (taskType === "sync-subscriptions") {
      // 订阅同步拉取与格式化校验任务
      const pool: Promise<void>[] = [];
      for (const sub of chunk) {
        if (pool.length >= concurrency) {
          await Promise.race(pool);
        }

        const promise = (async () => {
          const startTime = Date.now();
          try {
            const res = await fetch(sub.url, {
              headers: { "User-Agent": "LegadoSubscription/1.0" },
              signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            
            // 子线程解析耗时的 JSON
            const parsed = JSON.parse(text);
            const rawItems = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
            
            pPort!.postMessage({
              type: "result",
              id: sub.id,
              success: true,
              rawItems,
              duration: Date.now() - startTime
            });
          } catch (err: any) {
            pPort!.postMessage({
              type: "result",
              id: sub.id,
              success: false,
              error: err.message || err,
              duration: Date.now() - startTime
            });
          }
        })();

        pool.push(promise);
        promise.finally(() => {
          const idx = pool.indexOf(promise);
          if (idx !== -1) pool.splice(idx, 1);
        });
      }
      await Promise.all(pool);
      pPort!.postMessage({ type: "done" });
      process.exit(0);
    }
  };

  run().catch((err) => {
    console.error(`[Worker] 子线程未捕获致命异常:`, err);
    pPort!.postMessage({ type: "done" });
    process.exit(1);
  });
}

// ─────────────────────────────────────────────────────────────────────
// 2. 主线程多线程任务池调度逻辑 (Master WorkerPool Orchestrator)
// ─────────────────────────────────────────────────────────────────────
export async function runWorkerPool<T, R>(options: {
  taskType: "test-sources" | "sync-subscriptions";
  items: T[];
  threadCount?: number;
  concurrencyPerThread?: number;
  onResult: (result: any) => Promise<void> | void;
  onWorkerDone?: (workerIndex: number) => void;
  onActiveWorkers?: (workers: any[]) => void;
}): Promise<void> {
  const items = options.items;
  if (!items.length) return;

  let defaultThreadCount = 4;
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length) {
      defaultThreadCount = Math.max(1, Math.min(cpus.length, 8)); // 默认最高使用 8 个核心，防过度占用
    }
  } catch (_) {}

  if (typeof process !== "undefined" && process.env && process.env.THREAD_COUNT) {
    const parsed = parseInt(process.env.THREAD_COUNT, 10);
    if (!isNaN(parsed) && parsed > 0) {
      defaultThreadCount = parsed;
    }
  }

  const totalThreads = options.threadCount || Math.min(defaultThreadCount, items.length);
  const concurrency = options.concurrencyPerThread || 15;

  if (!WorkerClass) {
    // 降级为单线程高性能 Promise Pool 执行（针对 Cloudflare Workers 环境）
    console.log(`[WorkerPool] 环境不支持 Worker Threads，降级为单线程 Promise Pool 执行...`);
    const pool: Promise<void>[] = [];
    for (const item of items) {
      if (pool.length >= concurrency) {
        await Promise.race(pool);
      }
      const promise = (async () => {
        const anyItem = item as any;
        if (options.taskType === "test-sources") {
          const startTime = Date.now();
          try {
            const success = await checkBookSourceRealAvailability(anyItem.raw_json, anyItem.book_source_url);
            await options.onResult({
              type: "result",
              id: anyItem.id,
              available: success,
              duration: Date.now() - startTime
            });
          } catch (err: any) {
            await options.onResult({
              type: "result",
              id: anyItem.id,
              available: false,
              error: err.message || err,
              duration: Date.now() - startTime
            });
          }
        } else if (options.taskType === "sync-subscriptions") {
          const startTime = Date.now();
          try {
            const res = await fetch(anyItem.url, { headers: { "User-Agent": "LegadoSubscription/1.0" }, signal: AbortSignal.timeout(10000) });
            const text = await res.text();
            const parsed = JSON.parse(text);
            const rawItems = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" ? [parsed] : []);
            await options.onResult({
              type: "result",
              id: anyItem.id,
              success: true,
              rawItems,
              duration: Date.now() - startTime
            });
          } catch (err: any) {
            await options.onResult({
              type: "result",
              id: anyItem.id,
              success: false,
              error: err.message || err,
              duration: Date.now() - startTime
            });
          }
        }
      })();
      pool.push(promise);
      promise.finally(() => {
        const idx = pool.indexOf(promise);
        if (idx !== -1) pool.splice(idx, 1);
      });
    }
    await Promise.all(pool);
    return;
  }

  // Node.js 多线程 Chunk 任务分片分配
  const chunkSize = Math.ceil(items.length / totalThreads);
  const workers: any[] = [];
  let completedWorkers = 0;

  return new Promise<void>((resolve) => {
    const cleanUp = () => {
      completedWorkers++;
      if (completedWorkers >= workers.length) {
        resolve();
      }
    };

    const workerFilename = import.meta.filename || fileURLToPath(import.meta.url);

    for (let t = 0; t < totalThreads; t++) {
      const startIdx = t * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, items.length);
      const chunk = items.slice(startIdx, endIdx);

      if (chunk.length === 0) {
        completedWorkers++;
        continue;
      }

      const worker = new WorkerClass(workerFilename, {
        workerData: {
          taskType: options.taskType,
          chunk,
          concurrency
        }
      });

      workers.push(worker);

      worker.on("message", async (msg: any) => {
        if (msg.type === "result") {
          try {
            await options.onResult(msg);
          } catch (err) {
            console.error(`[WorkerPool] 执行 options.onResult 回调异常:`, err);
          }
        } else if (msg.type === "done") {
          if (options.onWorkerDone) options.onWorkerDone(t);
        }
      });

      worker.on("error", (err: any) => {
        console.error(`[WorkerPool] 工作线程 ${t + 1} 发生错误:`, err);
      });

      worker.on("exit", (code: number) => {
        if (code !== 0) {
          console.warn(`[WorkerPool] 工作线程 ${t + 1} 异常退出，退出码: ${code}`);
        }
        cleanUp();
      });
    }

    if (options.onActiveWorkers) {
      options.onActiveWorkers(workers);
    }

    if (workers.length === 0) {
      resolve();
    }
  });
}
