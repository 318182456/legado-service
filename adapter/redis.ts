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
    const keys = await this.redis.keys(pattern);
    const sortedKeys = keys.sort();
    
    // 简化实现：Redis 的 keys 性能在大数据量下较差，但在本项目场景下足够
    return {
      keys: sortedKeys.map(k => ({ name: k.slice(this.prefix.length) })),
      list_complete: true,
    };
  }
}
