/**
 * 任务执行体
 *
 * 主线程降级路径与工作线程执行同一份逻辑，两边行为不会再各自漂移。
 * 与 availability-check 一样不依赖 Node 内置模块，可直接在子线程沙盒里加载。
 */

// 本模块会被子线程加载，import 必须写全 .ts 扩展名
import { checkBookSource } from "./availability-check.ts";
import type { CheckVerdict } from "./availability-check.ts";

export type TaskType = "test-sources" | "sync-subscriptions";

/** 单条任务结果。type 固定为 result，沿用原有消息协议 */
export interface TaskResult {
  type: "result";
  id: number;
  duration: number;
  /** test-sources：三态判定 */
  verdict?: CheckVerdict;
  /** test-sources：兼容字段，仅在 verdict 为 available 时为 true */
  available?: boolean;
  reason?: string;
  detail?: string;
  httpStatus?: number;
  /** sync-subscriptions */
  success?: boolean;
  rawItems?: any[];
  error?: string;
}

const SUBSCRIPTION_TIMEOUT_MS = 15000;
/** 订阅文件偶有几 MB，但再大就不是正常订阅了 */
const MAX_SUBSCRIPTION_BYTES = 32 * 1024 * 1024;

export async function executeTask(taskType: TaskType, item: any): Promise<TaskResult> {
  const startTime = Date.now();
  try {
    if (taskType === "test-sources") {
      const outcome = await checkBookSource(item.raw_json, item.book_source_url);
      return {
        type: "result",
        id: item.id,
        verdict: outcome.verdict,
        available: outcome.verdict === "available",
        reason: outcome.reason,
        detail: outcome.detail,
        httpStatus: outcome.httpStatus,
        duration: Date.now() - startTime,
      };
    }

    if (taskType === "sync-subscriptions") {
      const rawItems = await fetchSubscription(item.url);
      return {
        type: "result",
        id: item.id,
        success: true,
        rawItems,
        duration: Date.now() - startTime,
      };
    }

    throw new Error(`未知任务类型: ${taskType}`);
  } catch (err: any) {
    return {
      type: "result",
      id: item?.id,
      verdict: taskType === "test-sources" ? "unavailable" : undefined,
      available: taskType === "test-sources" ? false : undefined,
      reason: taskType === "test-sources" ? "task-error" : undefined,
      success: taskType === "sync-subscriptions" ? false : undefined,
      error: err?.message || String(err),
      duration: Date.now() - startTime,
    };
  }
}

async function fetchSubscription(url: string): Promise<any[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUBSCRIPTION_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "LegadoSubscription/1.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_SUBSCRIPTION_BYTES) {
      throw new Error(`订阅内容过大: ${buf.byteLength} 字节`);
    }
    // 去掉 BOM，否则 JSON.parse 直接报错
    const text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "").trim();
    if (!text) throw new Error("订阅内容为空");

    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
    return [];
  } finally {
    clearTimeout(timer);
  }
}
