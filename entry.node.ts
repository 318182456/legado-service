import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'path';
import fs from 'fs-extra';
import { PostgresD1 } from './adapter/postgres';
import { RedisKV } from './adapter/redis';
import { FileSystemR2 } from './adapter/fs-storage';
import worker from './worker/index';

const app = new Hono();

// ─── 配置与环境变量 ───────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/legado';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const ASSETS_PATH = process.env.ASSETS_PATH || './assets';
const PORT = Number(process.env.PORT) || 3000;
const API_SECRET = process.env.API_SECRET || '';
const READER_URL = process.env.READER_URL || 'http://localhost:8080';

// ─── 初始化适配器 ─────────────────────────────────────────────────
const db = new PostgresD1(DATABASE_URL);
const kv = new RedisKV(REDIS_URL, 'legado');
const r2 = new FileSystemR2(ASSETS_PATH);

const env = {
  DB: db,
  KV: kv,
  ASSETS_R2: r2,
  API_SECRET: API_SECRET,
  READER_URL: READER_URL,
} as any;

// ─── 路由处理 ─────────────────────────────────────────────────────

// 静态文件服务
app.use('/*', serveStatic({ root: './dist' }));

// API 与 订阅路由 (包含 WebDAV 方法支持)
const WEBDAV_METHODS = [
  'GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD',
  'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'
];

app.on(WEBDAV_METHODS, '*', async (c) => {
  const req = c.req.raw;
  
  // 模拟 Worker 环境中的 ctx
  const ctx = {
    waitUntil: (p: Promise<any>) => p.catch(console.error),
  } as any;

  // 调用原始 Worker 处理函数
  try {
    const res = await worker.fetch(req, env, ctx);
    return res;
  } catch (e) {
    console.error('Worker Error:', e);
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

// ─── 启动服务器 ───────────────────────────────────────────────────
console.log(`Server is running on http://localhost:${PORT}`);
console.log(`- Database: ${DATABASE_URL.split('@').pop()}`);
console.log(`- Redis: ${REDIS_URL}`);
console.log(`- Assets Path: ${path.resolve(ASSETS_PATH)}`);
console.log(`- Reader URL: ${READER_URL}`);

serve({
  fetch: app.fetch,
  port: PORT,
});

// 模拟 Cloudflare Scheduled Events (定时任务)
// 默认每 24 小时执行一次
const CRON_INTERVAL = 24 * 60 * 60 * 1000;
setInterval(async () => {
  console.log('Running scheduled tasks...');
  try {
    const ctx = { waitUntil: (p: Promise<any>) => p.catch(console.error) };
    await worker.scheduled({ scheduledTime: Date.now(), cron: '0 22 * * *' } as any, env, ctx);
  } catch (e) {
    console.error('Scheduled Task Failed:', e);
  }
}, CRON_INTERVAL);
