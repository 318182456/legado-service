/**
 * 书源测试与订阅同步的公共入口
 *
 * 实现拆分在以下模块，改动请直接找对应文件：
 * - availability-check.ts  书源可用性判定（三态）
 * - worker-tasks.ts        任务执行体，主线程与子线程共用
 * - worker-entry.ts        工作线程入口，只由 worker-pool 加载
 * - worker-pool.ts         线程池调度与单线程降级
 */

export { checkBookSource, checkBookSourceRealAvailability } from "./availability-check";
export type { CheckOutcome, CheckVerdict, CheckOptions } from "./availability-check";

export { runWorkerPool } from "./worker-pool";
export type { WorkerPoolOptions } from "./worker-pool";

export type { TaskResult, TaskType } from "./worker-tasks";
