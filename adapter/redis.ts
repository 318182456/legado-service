import Redis from 'ioredis';

/**
 * 模拟 Cloudflare KVNamespace 接口的 Redis 适配器
 */
export class RedisKV {
  private redis: Redis;
  private prefix: string;

  constructor(connectionString: string, namespace: string) {
    this.redis = new Redis(connectionString);
    this.prefix = `kv:${namespace}:`;

    // 添加错误监听，防止未捕获异常导致进程崩溃
    this.redis.on('error', (err) => {
      console.error(`Redis Error [${namespace}]:`, err.message);
    });
  }

  async get(key: string, type: 'text' | 'json' | 'arrayBuffer' | 'stream' = 'text'): Promise<any> {
    const val = await this.redis.get(this.prefix + key);
    if (val === null) return null;
    if (type === 'json') return JSON.parse(val);
    return val;
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: { expirationTtl?: number }): Promise<void> {
    let val: string;
    if (typeof value === 'string') {
      val = value;
    } else {
      val = Buffer.from(value as any).toString();
    }

    if (options?.expirationTtl) {
      await this.redis.set(this.prefix + key, val, 'EX', options.expirationTtl);
    } else {
      await this.redis.set(this.prefix + key, val);
    }
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<any> {
    const pattern = this.prefix + (options?.prefix || '') + '*';
    const keys: string[] = [];
    let cursor = '0';

    // 用 SCAN 迭代避免 KEYS 在大数据量时阻塞 Redis 主线程
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    const sortedKeys = keys.sort();
    return {
      keys: sortedKeys.map(k => ({ name: k.slice(this.prefix.length) })),
      list_complete: true,
    };
  }
}
