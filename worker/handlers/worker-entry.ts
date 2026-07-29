/**
 * 工作线程入口
 *
 * 只被 worker-pool 通过 new Worker() 加载，不要从别处 import ——
 * 模块顶层就会开始监听任务消息。
 *
 * 任务不再由 workerData 一次性下发，而是主线程按需派发（见 worker-pool）：
 * 线程内的在途数量由主线程控制，因此这里不需要自己做并发池。
 */

// 子线程没有 TS 解析器，import 必须写全 .ts 扩展名，否则 ERR_MODULE_NOT_FOUND
import { executeTask } from "./worker-tasks.ts";
import type { TaskType } from "./worker-tasks.ts";

const { parentPort, workerData } = await import("worker_threads");

if (parentPort) {
  const port = parentPort;
  const taskType: TaskType = workerData?.taskType;
  let inflight = 0;
  let draining = false;

  const closeIfIdle = () => {
    if (draining && inflight === 0) port.close();
  };

  port.on("message", (msg: any) => {
    if (msg?.type === "task") {
      inflight++;
      executeTask(taskType, msg.item)
        .then((result) => port.postMessage(result))
        .catch((err: any) => {
          // executeTask 自己兜了异常，走到这里说明是 postMessage 失败之类的意外
          port.postMessage({
            type: "result",
            id: msg.item?.id,
            verdict: taskType === "test-sources" ? "unavailable" : undefined,
            available: taskType === "test-sources" ? false : undefined,
            success: taskType === "sync-subscriptions" ? false : undefined,
            reason: "worker-error",
            error: err?.message || String(err),
            duration: 0,
          });
        })
        .finally(() => {
          inflight--;
          closeIfIdle();
        });
      return;
    }

    if (msg?.type === "shutdown") {
      draining = true;
      closeIfIdle();
    }
  });

  port.postMessage({ type: "ready" });
}
