import fs from 'fs-extra';
import path from 'path';
import mime from 'mime-types';

/**
 * 模拟 Cloudflare R2Bucket 接口的本地文件系统适配器 (NAS)
 */
export class FileSystemR2 {
  private root: string;

  constructor(rootPath: string) {
    this.root = path.resolve(rootPath);
    fs.ensureDirSync(this.root);
  }

  private getPath(key: string) {
    // 防止路径穿越
    const safeKey = key.replace(/\.\./g, '');
    return path.join(this.root, safeKey);
  }

  async get(key: string, options?: { range?: string }): Promise<any> {
    const p = this.getPath(key);
    if (!(await fs.pathExists(p))) return null;
    
    let body = await fs.readFile(p);
    let status = 200;
    
    // 简易 Range 处理
    if (options?.range) {
      const parts = options.range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : body.length - 1;
      body = body.subarray(start, end + 1);
      status = 206;
    }

    const contentType = mime.lookup(p) || 'application/octet-stream';
    const etag = `"${encodeURIComponent(key)}-${body.length}"`;

    return {
      // 模拟 R2ObjectBody 接口
      body: body, // Buffer 可以直接作为 Response 的 body
      arrayBuffer: async () => body.buffer,
      text: async () => body.toString(),
      json: async () => JSON.parse(body.toString()),
      blob: async () => new Blob([body], { type: contentType }),
      
      httpMetadata: { contentType },
      httpEtag: etag,
      size: body.length,
      writeHttpMetadata: (headers: Headers) => {
        headers.set('Content-Type', contentType);
        headers.set('ETag', etag);
      }
    };
  }

  async put(key: string, value: any, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<void> {
    const p = this.getPath(key);
    await fs.ensureDir(path.dirname(p));
    
    if (value instanceof ArrayBuffer) {
      await fs.writeFile(p, Buffer.from(value));
    } else if (typeof value === 'string') {
      await fs.writeFile(p, value);
    } else if (value?.arrayBuffer) {
      // 处理类似 Request/Response 的 body
      const ab = await value.arrayBuffer();
      await fs.writeFile(p, Buffer.from(ab));
    } else {
      await fs.writeFile(p, value);
    }

    // 将 customMetadata 持久化为伴随文件，供 head() 读取
    if (options?.customMetadata) {
      await fs.writeJson(p + '.meta.json', options.customMetadata);
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.getPath(key);
    await fs.remove(p);
    // 同时删除伴随元数据文件
    await fs.remove(p + '.meta.json').catch(() => {});
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<any> {
    // 递归列出所有文件（过滤 .meta.json 伴随文件）
    const files: string[] = [];
    const prefix = options?.prefix || '';
    
    const walk = async (dir: string) => {
      const list = await fs.readdir(dir);
      for (const item of list) {
        const fullPath = path.join(dir, item);
        const relPath = path.relative(this.root, fullPath).replace(/\\/g, '/');
        const stat = await fs.stat(fullPath);
        
        if (stat.isDirectory()) {
          await walk(fullPath);
        } else {
          // 过滤掉元数据伴随文件
          if (relPath.startsWith(prefix) && !relPath.endsWith('.meta.json')) {
            files.push(relPath);
          }
        }
      }
    };

    if (await fs.pathExists(this.root)) {
      await walk(this.root);
    }

    const objects = [];
    for (const f of files.sort()) {
      const p = this.getPath(f);
      const stat = await fs.stat(p);
      objects.push({
        key: f,
        size: stat.size,
        uploaded: stat.mtime
      });
    }

    return {
      objects,
      truncated: false,
    };
  }

  async head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null> {
    const p = this.getPath(key);
    if (!(await fs.pathExists(p))) return null;
    const stat = await fs.stat(p);
    
    // 读取伴随的元数据文件
    let customMetadata: Record<string, string> | undefined;
    try {
      if (await fs.pathExists(p + '.meta.json')) {
        customMetadata = await fs.readJson(p + '.meta.json');
      }
    } catch (_) {}

    return {
      size: stat.size,
      httpMetadata: {
        contentType: mime.lookup(p) || 'application/octet-stream'
      },
      customMetadata,
    };
  }
}
