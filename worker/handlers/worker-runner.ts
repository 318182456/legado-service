import { fileURLToPath } from "url";
import os from "os";

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
          const fetchOptions: RequestInit = {
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            },
            signal: AbortSignal.timeout(5000)
          };

          try {
            const res = await fetch(source.urlToTest, fetchOptions);
            await res.body?.cancel();
            const duration = Date.now() - startTime;
            const success = res.status >= 200 && res.status < 400;
            pPort!.postMessage({
              type: "result",
              id: source.id,
              available: success,
              status: res.status,
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
            const res = await fetch(anyItem.urlToTest, { signal: AbortSignal.timeout(5000) });
            await res.body?.cancel();
            const success = res.status >= 200 && res.status < 400;
            await options.onResult({
              type: "result",
              id: anyItem.id,
              available: success,
              status: res.status,
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
