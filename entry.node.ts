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

// ─── 加载 .env 本地环境变量 ──────────────────────────────────────────
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.substring(0, index).trim();
    const value = trimmed.substring(index + 1).trim().replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

// ─── 配置与环境变量 ───────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/legado';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const ASSETS_PATH = process.env.ASSETS_PATH || './assets';
const PORT = Number(process.env.PORT) || 3000;
const API_SECRET = process.env.API_SECRET || '';
const READER_URL = process.env.READER_URL || 'http://localhost:8080';

// ─── 内存 Mock 适配器 (免数据库运行模式) ─────────────────────────────
class MemoryPreparedStatement {
  constructor(private results: any[] = []) {}
  bind(...params: any[]) { return this; }
  async all() { return { results: this.results, success: true, meta: { duration: 0 } }; }
  async first(col?: string) { 
    const r = this.results[0]; 
    if (!r) return null;
    return col ? r[col] : r; 
  }
  async run() { return { success: true, meta: { changes: this.results.length, duration: 0, last_row_id: 1 } }; }
  async raw() { return this.results.map(r => Object.values(r)); }
}

class MemoryD1 {
  private tables: Record<string, any[]> = {
    passkeys: [],
    subscriptions: [],
    sources: [],
    rules: [],
    txt_toc_rules: [],
    dict_rules: [],
    system_config: []
  };

  prepare(query: string) {
    const sql = query.trim().toUpperCase();
    let results: any[] = [];
    if (sql.includes('PASSKEYS')) results = this.tables.passkeys;
    else if (sql.includes('SUBSCRIPTIONS')) results = this.tables.subscriptions;
    else if (sql.includes('SOURCES')) results = this.tables.sources;
    else if (sql.includes('RULES')) results = this.tables.rules;
    else if (sql.includes('TXT_TOC_RULES')) results = this.tables.txt_toc_rules;
    else if (sql.includes('DICT_RULES')) results = this.tables.dict_rules;
    else if (sql.includes('SYSTEM_CONFIG')) results = this.tables.system_config;

    return new MemoryPreparedStatement(results);
  }

  async batch(statements: any[]) {
    const res = [];
    for (const stmt of statements) {
      res.push(await stmt.run());
    }
    return res;
  }

  async exec(query: string) {
    return { count: 0, duration: 0 };
  }
}

class MemoryKV {
  private store: Record<string, string> = {};
  async get(key: string) { return this.store[key] || null; }
  async put(key: string, value: string) { this.store[key] = value; }
  async delete(key: string) { delete this.store[key]; }
}

// ─── 初始化适配器 ─────────────────────────────────────────────────
const useMock = process.env.USE_MEMORY_MOCK === 'true';

if (useMock) {
  console.log('⚡ WARNING: Enrolled in memory mock database mode (USE_MEMORY_MOCK=true). No DB required!');
}

const db = useMock ? new MemoryD1() as any : new PostgresD1(DATABASE_URL);
const kv = useMock ? new MemoryKV() as any : new RedisKV(REDIS_URL, 'legado');
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
// 默认每 24 小时执行一次，带防重入机制
const CRON_INTERVAL = 24 * 60 * 60 * 1000;
let scheduledRunning = false;

setInterval(async () => {
  if (scheduledRunning) {
    console.warn('[Cron] 上次定时任务尚未完成，跳过本次触发');
    return;
  }
  scheduledRunning = true;
  console.log('Running scheduled tasks...');
  try {
    const ctx = { waitUntil: (p: Promise<any>) => p.catch(console.error) };
    await worker.scheduled({ scheduledTime: Date.now(), cron: '0 22 * * *' } as any, env, ctx);
  } catch (e) {
    console.error('Scheduled Task Failed:', e);
  } finally {
    scheduledRunning = false;
  }
}, CRON_INTERVAL);
