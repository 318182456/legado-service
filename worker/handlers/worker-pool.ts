/**
 * 多线程任务池调度
 *
 * 与原实现的三处区别：
 * 1. 任务按需派发而非静态分片 —— 慢任务不再拖住整个分片，快线程也不会提前空闲。
 * 2. onResult 串行执行，调用方不必再自己防并发写入。
 * 3. 线程创建失败（无 TS loader、Cloudflare Workers 等环境）自动降级为单线程，
 *    不再依赖调用点判断运行环境。
 */

import { executeTask } from "./worker-tasks.ts";
import type { TaskResult, TaskType } from "./worker-tasks.ts";

export interface WorkerPoolOptions<T> {
  taskType: TaskType;
  items: T[];
  threadCount?: number;
  /** 单线程在途任务数 */
  concurrencyPerThread?: number;
  onResult: (result: TaskResult) => Promise<void> | void;
  onWorkerDone?: (workerIndex: number) => void;
  /** 暴露线程句柄供外部中止（terminate 后剩余任务不再派发） */
  onActiveWorkers?: (workers: any[]) => void;
}

const DEFAULT_THREAD_COUNT = 4;
const MAX_THREAD_COUNT = 8;
const DEFAULT_CONCURRENCY = 15;

/** Node 环境探测。在 Cloudflare Workers 里这些内置模块不可用，直接走单线程 */
const nodeProcess: any = (globalThis as any).process;
const isNode = !!nodeProcess?.versions?.node;

let workerModule: any = null;
let osModule: any = null;
if (isNode) {
  try {
    workerModule = await import("worker_threads");
    osModule = await import("os");
  } catch (_) {
    workerModule = null;
  }
}

export async function runWorkerPool<T>(options: WorkerPoolOptions<T>): Promise<void> {
  const items = options.items;
  if (!items.length) return;

  const concurrency = options.concurrencyPerThread || DEFAULT_CONCURRENCY;
  const threadCount = Math.max(1, Math.min(options.threadCount || defaultThreadCount(), items.length));

  // onResult 串行化：保证调用方的批量缓冲区不会被并发进入
  let resultChain: Promise<void> = Promise.resolve();
  const dispatchResult = (result: TaskResult) => {
    resultChain = resultChain.then(async () => {
      try {
        await options.onResult(result);
      } catch (err) {
        console.error("[WorkerPool] onResult 回调异常:", err);
      }
    });
    return resultChain;
  };

  let pending = items;

  if (workerModule?.Worker) {
    const run = await runOnWorkerThreads(options, items, threadCount, concurrency, dispatchResult);
    if (run.aborted) {
      await resultChain;
      return;
    }
    // 线程一个都没起来时 pending 仍是全量，交给下面的单线程路径；
    // 线程中途集体阵亡时 pending 是它们没做完的部分，同样在主线程补完
    pending = run.remaining as T[];
    if (!pending.length) {
      await resultChain;
      return;
    }
    if (!run.spawned) {
      console.log("[WorkerPool] 工作线程不可用，降级为单线程执行");
    } else {
      console.warn(`[WorkerPool] ${pending.length} 个任务因线程退出未完成，改由主线程补跑`);
    }
  }

  console.log(`[WorkerPool] 使用单线程 Promise Pool 执行 ${pending.length} 个任务...`);
  await runSingleThreaded(options.taskType, pending, concurrency, dispatchResult);
  await resultChain;
}

function defaultThreadCount(): number {
  const configured = parseInt(nodeProcess?.env?.THREAD_COUNT || "", 10);
  if (!isNaN(configured) && configured > 0) return configured;
  try {
    const cores = osModule?.cpus()?.length;
    // 留出核心给主线程处理数据库写入
    if (cores) return Math.max(1, Math.min(cores - 1, MAX_THREAD_COUNT));
  } catch (_) {}
  return DEFAULT_THREAD_COUNT;
}

// ─────────────────────────────────────────────────────────────────────
// 多线程执行
// ─────────────────────────────────────────────────────────────────────

interface ThreadRunResult<T> {
  /** 是否有线程真正跑起来过（false 表示环境不支持，应降级） */
  spawned: boolean;
  /** 被外部中止 */
  aborted: boolean;
  /** 没能派发或没能跑完的任务 */
  remaining: T[];
}

async function runOnWorkerThreads<T>(
  options: WorkerPoolOptions<T>,
  items: T[],
  threadCount: number,
  concurrency: number,
  dispatchResult: (result: TaskResult) => Promise<void>
): Promise<ThreadRunResult<T>> {
  let entryPath: string;
  try {
    const { fileURLToPath } = await import("url");
    entryPath = fileURLToPath(new URL("./worker-entry.ts", import.meta.url));
  } catch (err) {
    console.warn("[WorkerPool] 无法定位工作线程入口:", err);
    return { spawned: false, aborted: false, remaining: items };
  }

  const queue = [...items];
  const workers: any[] = [];
  let aborted = false;
  let readyWorkers = 0;

  await new Promise<void>((resolve) => {
    let liveWorkers = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const pump = (worker: any) => {
      if (aborted || worker.__dead) return;
      while (queue.length > 0 && worker.__pending.size < concurrency) {
        const item = queue.shift();
        // 记住派出去的任务，线程半路死掉时才能把它们放回队列
        worker.__pending.set((item as any)?.id, item);
        worker.postMessage({ type: "task", item });
      }
      if (queue.length === 0 && worker.__pending.size === 0 && !worker.__shutdown) {
        worker.__shutdown = true;
        worker.postMessage({ type: "shutdown" });
      }
    };

    for (let t = 0; t < threadCount; t++) {
      let worker: any;
      try {
        worker = new workerModule.Worker(entryPath, {
          workerData: { taskType: options.taskType },
        });
      } catch (err) {
        console.warn(`[WorkerPool] 工作线程 ${t + 1} 创建失败:`, err);
        break;
      }

      worker.__pending = new Map<any, T>();
      worker.__shutdown = false;
      worker.__dead = false;
      worker.__index = t;
      workers.push(worker);
      liveWorkers++;

      worker.on("message", (msg: any) => {
        if (msg?.type === "ready") {
          readyWorkers++;
          pump(worker);
          return;
        }
        if (msg?.type !== "result") return;

        worker.__pending.delete(msg.id);
        dispatchResult(msg as TaskResult);
        pump(worker);
      });

      worker.on("error", (err: any) => {
        console.error(`[WorkerPool] 工作线程 ${worker.__index + 1} 发生错误:`, err?.message || err);
      });

      worker.on("exit", (code: number) => {
        if (code !== 0 && !aborted) {
          console.warn(`[WorkerPool] 工作线程 ${worker.__index + 1} 异常退出，退出码: ${code}`);
        }
        worker.__dead = true;
        // 它手上没回结果的任务退回队列，交给别的线程或主线程重做
        if (!aborted && worker.__pending.size > 0) {
          queue.push(...worker.__pending.values());
          worker.__pending.clear();
        }
        if (options.onWorkerDone) options.onWorkerDone(worker.__index);

        liveWorkers--;
        if (liveWorkers > 0) {
          for (const w of workers) pump(w);
          return;
        }
        finish();
      });
    }

    if (workers.length === 0) {
      finish();
      return;
    }

    if (options.onActiveWorkers) {
      // 外部调用 terminate() 中止后，退出事件会收敛到 finish()
      options.onActiveWorkers(
        workers.map((w) => ({
          terminate: () => {
            aborted = true;
            queue.length = 0;
            return w.terminate();
          },
        }))
      );
    }
  });

  if (aborted) console.log("[WorkerPool] 任务已被外部中止");
  return { spawned: readyWorkers > 0, aborted, remaining: aborted ? [] : queue };
}

// ─────────────────────────────────────────────────────────────────────
// 单线程降级执行
// ─────────────────────────────────────────────────────────────────────

async function runSingleThreaded<T>(
  taskType: TaskType,
  items: T[],
  concurrency: number,
  dispatchResult: (result: TaskResult) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      const result = await executeTask(taskType, item);
      dispatchResult(result);
    }
  });
  await Promise.all(workers);
}
