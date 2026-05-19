// ─── 核心接口定义 (脱离 Cloudflare Types) ──────────────────────────

export interface KVNamespace {
  get(key: string, type?: string): Promise<any>;
  put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[] }>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<any>;
  exec(query: string): Promise<any>;
}

export interface D1PreparedStatement {
  bind(...params: any[]): D1PreparedStatement;
  first(column?: string): Promise<any>;
  all(): Promise<{ results: any[] }>;
  run(): Promise<any>;
  raw(): Promise<any[]>;
}

export interface R2Bucket {
  get(key: string, options?: { range?: string }): Promise<any>;
  put(key: string, value: any, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<any>;
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
}

// ─── 环境绑定 ────────────────────────────────────────────────────
export interface Env {
  /** KV: 订阅输出缓存 */
  KV: KVNamespace;
  /** D1: 持久化存储 */
  DB: D1Database;
  /** 管理 API 鉴权密钥（备用） */
  API_SECRET: string;
  /** 管理员密码（首次登录用） */
  ADMIN_PASSWORD?: string;
  /** R2: 静态资源存储 */
  ASSETS_R2: R2Bucket;
  /** Reader: 官方后端代理 URL */
  READER_URL?: string;
}

// KV 缓存 TTL（秒）
export const CACHE_TTL = 3600; // 1 小时
