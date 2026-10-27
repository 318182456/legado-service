import { Env } from "../types";
import {
  err,
  checkAuth,
} from "../utils";
import { unzipSync, zipSync } from "fflate";


export async function handleRepoProxy(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const rawKey = path.replace("/repo/", "");
  
  // 1. 获取客户端请求的 Range
  const range = request.headers.get('Range');
  
  // 2. 尝试从 R2 获取对象
  let object = await env.ASSETS_R2.get(rawKey, {
    range: range || undefined,
  });
  
  if (!object) {
    try {
      const decodedKey = decodeURIComponent(rawKey);
      if (decodedKey !== rawKey) {
        object = await env.ASSETS_R2.get(decodedKey, { range: range || undefined });
      }
    } catch (e) {}
  }

  if (!object && rawKey.includes("+")) {
    try {
      const spaceKey = decodeURIComponent(rawKey.replace(/\+/g, " "));
      object = await env.ASSETS_R2.get(spaceKey, { range: range || undefined });
    } catch (e) {}
  }

  if (!object) return err(`Resource Not Found: ${rawKey}`, 404);
  
  const headers = new Headers();
  object.writeHttpMetadata(headers as any);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Accept-Ranges", "bytes");
  
  // 强缓存策略
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  
  // 处理分片下载的状态码
  const status = range ? 206 : 200;

  const ext = rawKey.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
    "webp": "image/webp", "gif": "image/gif", "ttf": "font/ttf",
    "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2"
  };
  if (ext && mimeTypes[ext]) {
    headers.set("Content-Type", mimeTypes[ext]);
  }
  
  return new Response(object.body as any, { status, headers });
}

export async function handleResourcesList(env: Env): Promise<Response> {
  const data = await env.KV.get("resources-index");
  const json = data ? JSON.parse(data) : {};
  return new Response(JSON.stringify({ ok: true, data: json }), { 
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
  });
}

/**
 * 重新扫描 R2 并重建资源索引
 */
export async function handleResourcesRefresh(env: Env): Promise<Response> {
  const listed = await env.ASSETS_R2.list();
  const index: Record<string, any[]> = {};

  for (const obj of listed.objects) {
    const key = obj.key;
    const parts = key.split('/');
    if (parts.length < 2) continue;
    
    let category, name;
    if (parts[0] === 'uploads' && parts.length >= 3) {
      category = parts[1];
      name = parts.slice(2).join('/');
    } else {
      category = parts[0];
      name = parts.slice(1).join('/');
    }
    
    if (!index[category]) index[category] = [];
    
    index[category].push({
      name,
      path: key,
      size: obj.size,
      mtime: obj.uploaded ? new Date(obj.uploaded).toISOString() : new Date().toISOString()
    });
  }

  await env.KV.put("resources-index", JSON.stringify(index));
  return new Response(JSON.stringify({ ok: true, data: index }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export async function handleR2List(request: Request, env: Env): Promise<Response> {
  if (!checkAuth(request, env)) return err("Unauthorized", 401);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.ASSETS_R2.list({ limit: 1000, cursor });
    listed.objects.forEach((obj: any) => keys.push(obj.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return new Response(JSON.stringify({ ok: true, data: keys, total: keys.length }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// ---------- 精选主题管理 ----------

export async function handleListCustomThemes(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM custom_themes ORDER BY created_at DESC"
  ).all();
  return new Response(JSON.stringify({ ok: true, data: results }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export async function handleSaveCustomTheme(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as any;
  if (!body.name || !body.config) return err("Name and Config are required");

  if (body.id) {
    await env.DB.prepare(
      "UPDATE custom_themes SET name = ?, config = ?, preview_url = ? WHERE id = ?"
    ).bind(body.name, body.config, body.preview_url || null, body.id).run();
  } else {
    await env.DB.prepare(
      "INSERT INTO custom_themes (name, config, preview_url) VALUES (?, ?, ?)"
    ).bind(body.name, body.config, body.preview_url || null).run();
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export async function handleDeleteCustomTheme(id: number, env: Env): Promise<Response> {
  await env.DB.prepare("DELETE FROM custom_themes WHERE id = ?").bind(id).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// ---------- ZIP 导出逻辑 (极简 Store 模式) ----------

/** 使用现有 ZIP 库处理 UTF-8 文件名和字节偏移，避免中文资源生成损坏的包。 */
class ZipWriter {
  private files: Record<string, Uint8Array> = Object.create(null);
  addFile(name: string, data: Uint8Array | string) {
    this.files[name] = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  }
  generate(): Uint8Array { return zipSync(this.files, { level: 0 }); }
}

export async function handleExportCustomTheme(request: Request, env: Env, idStr: string): Promise<Response> {
  const id = parseInt(idStr);
  const result = await env.DB.prepare(
    "SELECT config FROM custom_themes WHERE id = ?"
  ).bind(id).first() as any;
  
  if (!result) return err("Theme Not Found", 404);
  
  const config = JSON.parse(result.config);
  
  // 确保 themeName 存在并发给 Legado，因为 Legado 原生依靠 themeName 来识别和覆盖同名主题
  config.themeName = config.themeName || config.name || "自定义主题";
  
  const zip = new ZipWriter();
  const usedNames = new Set(['readConfig.json']);
  const resources = new Map<string, Promise<string>>();

  // 辅助函数：从 R2 抓取资源并添加到 ZIP
  const readResource = async (path: string) => {
    if (!path || path.startsWith('#')) return path;
    
    // 提取 key (去除 http 前缀)
    let key = path.startsWith('http') ? path.split('/repo/').pop() : path;
    if (!key) return path;

    key = decodeURIComponent(key);
    
    // 尝试多种路径匹配 (逻辑同步自 handleRepoProxy)
    let obj = await env.ASSETS_R2.get(key);
    if (!obj && key.includes(' ')) {
      obj = await env.ASSETS_R2.get(key.replace(/ /g, '+'));
    }
    if (!obj && key.includes('+')) {
      obj = await env.ASSETS_R2.get(key.replace(/\+/g, ' '));
    }

    if (obj) {
      const data = await obj.arrayBuffer();
      const baseName = key.split('/').pop()!;
      let fileName = baseName;
      let index = 2;
      while (usedNames.has(fileName)) {
        const dot = baseName.lastIndexOf('.');
        fileName = dot > 0 ? `${baseName.slice(0, dot)}_${index++}${baseName.slice(dot)}` : `${baseName}_${index++}`;
      }
      usedNames.add(fileName);
      // Legado 源码显示它会从解压后的根目录找文件，所以不要带 fonts/ 或 bg/ 前缀
      zip.addFile(fileName, new Uint8Array(data));
      return fileName;
    }
    
    // 如果没找到，至少返回文件名，防止带路径导致 App 查找彻底失败
    return key.split('/').pop()!;
  };

  const processResource = (path: string, _type: 'fonts' | 'bg') => {
    if (!resources.has(path)) resources.set(path, readResource(path));
    return resources.get(path)!;
  };

  const tasks: Promise<any>[] = [];

  // 1. 处理字体 (并行)
  if (config.textFont) {
    tasks.push(processResource(config.textFont, 'fonts').then(v => config.textFont = v));
  }

  // 2. 处理三个背景字段 (并行)
  if (config.bgType === 2 && config.bgStr) {
    tasks.push(processResource(config.bgStr, 'bg').then(v => config.bgStr = v));
  }

  // 并行等待所有资源处理完成
  await Promise.all(tasks);

  // 3. 清理非标准字段
  delete config.preview_url;

  // 4. 补齐夜间 / 墨水屏字段。
  // Legado 的 Gson 未启用 Kotlin 默认值，缺失字段会反序列化成 null/0 而非构造函数默认值，
  // 其中 textColorNight 没有兜底逻辑，缺失会导致夜间取色失败。
  // 旧版本保存的主题不含 *Night / *EInk 字段，这里统一按日间值补齐。
  const variantFallback: Record<string, string> = {
    bgStrNight: 'bgStr',
    bgTypeNight: 'bgType',
    textColorNight: 'textColor',
    darkStatusIconNight: 'darkStatusIcon',
    bgStrEInk: 'bgStr',
    bgTypeEInk: 'bgType',
    textColorEInk: 'textColor',
    darkStatusIconEInk: 'darkStatusIcon'
  };
  for (const [nightKey, dayKey] of Object.entries(variantFallback)) {
    if (config[nightKey] === undefined || config[nightKey] === null || config[nightKey] === '') {
      config[nightKey] = config[dayKey];
    }
  }

  // 5. 补齐后再处理夜间/墨水屏背景图，确保单独设置的图片也能打进 ZIP。
  // 与日间同值的说明是上面回退来的，日间那轮已处理并入包，跳过避免重复查 R2。
  const nightTasks: Promise<any>[] = [];
  if (config.bgTypeNight === 2 && config.bgStrNight && config.bgStrNight !== config.bgStr) {
    nightTasks.push(processResource(config.bgStrNight, 'bg').then(v => config.bgStrNight = v));
  }
  if (config.bgTypeEInk === 2 && config.bgStrEInk && config.bgStrEInk !== config.bgStr) {
    nightTasks.push(processResource(config.bgStrEInk, 'bg').then(v => config.bgStrEInk = v));
  }
  await Promise.all(nightTasks);

  // 6. 添加 JSON 配置
  zip.addFile('readConfig.json', JSON.stringify(config, null, 2));

  return new Response(zip.generate() as any, {
    headers: { 
      "Content-Type": "application/zip", 
      "Access-Control-Allow-Origin": "*",
      "Content-Disposition": `attachment; filename="theme_${id}.zip"`,
      "Cache-Control": "public, max-age=3600"
    }
  });
}

// ---------- 资源确保存储逻辑 (查重 -> 上传 -> 更新索引) ----------

/** 
 * 核心存储逻辑：计算哈希 -> 存入 R2 -> 更新 KV 索引
 * 去重策略：将 SHA-256 哈希存入 R2 customMetadata，用 head() 比对，避免下载全量文件
 */
async function saveAsset(
  env: Env, 
  data: Uint8Array, 
  category: string, 
  name: string, 
  contentType?: string
): Promise<string> {
  // 1. 计算 SHA-256 哈希
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as any);
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  const decodedName = decodeURIComponent(name).split('/').pop() || name;
  const r2Key = `uploads/${category}/${decodedName}`;

  // 2. 用 head() 获取已有对象的元数据，避免下载全量内容
  const existingHead = await env.ASSETS_R2.head(r2Key);
  if (existingHead) {
    const existingHash = existingHead.customMetadata?.sha256;
    if (existingHash === hashHex) return r2Key; // 内容一致，跳过上传
  }

  // 3. 上传 R2，将哈希写入 customMetadata
  await env.ASSETS_R2.put(r2Key, data, {
    httpMetadata: contentType ? { contentType } : undefined,
    customMetadata: { sha256: hashHex },
  });

  // 4. 更新 KV 索引
  const indexData = await env.KV.get("resources-index");
  const index = indexData ? JSON.parse(indexData) : {};
  if (!index[category]) index[category] = [];
  
  const existsInIndex = index[category].some((item: any) => item.path === r2Key);
  if (!existsInIndex) {
    index[category].push({
      name: decodedName,
      path: r2Key,
      size: data.length,
      mtime: new Date().toISOString()
    });
    await env.KV.put("resources-index", JSON.stringify(index));
  }

  return r2Key;
}

export async function handleEnsureAsset(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const file = formData.get('file') as File;
  const category = formData.get('category') as string;
  const originalName = formData.get('name') as string;

  if (!file || !category) return err("File and category are required");

  const buffer = await file.arrayBuffer();
  const path = await saveAsset(env, new Uint8Array(buffer), category, originalName, file.type);

  return new Response(JSON.stringify({ ok: true, path }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// ---------- ZIP 资产记录与提取 ----------

export async function handleListZipAssets(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const zipPath = url.searchParams.get("path");
  if (!zipPath) return err("path is required");

  const object = await env.ASSETS_R2.get(zipPath);
  if (!object) return err("ZIP not found", 404);

  const buffer = await object.arrayBuffer();
  const unzipped = unzipSync(new Uint8Array(buffer));
  
  const assets = Object.keys(unzipped)
    .filter(name => {
      const ext = name.split('.').pop()?.toLowerCase() || '';
      return ['ttf', 'otf', 'woff', 'woff2', 'jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
    })
    .map(name => ({
      name: name.split('/').pop() || name,
      path: name,
      size: unzipped[name].length
    }));

  return new Response(JSON.stringify({ ok: true, data: assets }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export async function handleExtractAssetFromZip(request: Request, env: Env): Promise<Response> {
  const { zipPath, internalPath, category } = await request.json() as any;
  if (!zipPath || !internalPath || !category) return err("zipPath, internalPath and category are required");

  const object = await env.ASSETS_R2.get(zipPath);
  if (!object) return err("ZIP not found", 404);

  const buffer = await object.arrayBuffer();
  const unzipped = unzipSync(new Uint8Array(buffer));
  const fileData = unzipped[internalPath];

  if (!fileData) return err("File not found in ZIP", 404);

  const ext = internalPath.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
    "ttf": "font/ttf", "otf": "font/otf", "woff": "font/woff", "woff2": "font/woff2"
  };

  const path = await saveAsset(env, fileData, category, internalPath, mimeTypes[ext]);

  return new Response(JSON.stringify({ ok: true, data: { path } }), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}



/**
 * AI 配色助手：按一句话描述生成一套三态主题，供样式实验室预填。
 * 只返回建议，不落库——用户在实验室里调完再自行保存。
 */
export async function handleSuggestTheme(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as any;
  const prompt = String(body?.prompt ?? "").trim();
  if (!prompt) return err("请描述想要的主题");
  if (prompt.length > 2000) return err("主题描述请控制在 2000 字以内");

  // 从资源索引里取真实存在的字体与背景，避免模型编造文件名
  const raw = await env.KV.get("resources-index");
  const index = raw ? JSON.parse(raw) : {};
  const collect = (cats: string[], exts: RegExp) => {
    const out: string[] = [];
    for (const cat of cats) {
      for (const item of (index[cat] ?? []) as any[]) {
        if (item?.path && exts.test(item.path)) out.push(item.path);
      }
    }
    return out;
  };

  /**
   * 资源索引是按文件名排序的，直接截前 N 个会让模型只看到开头那一段
   * （字体有 146 个，楷书宋体明朝体全排在 60 名开外，等于永远选不到）。
   * 同一字族的多个字重（仓耳非白 W01~W05）先收敛成一个，再在全表上均匀取样。
   */
  const sample = (list: string[], limit: number) => {
    const byFamily = new Map<string, string>();
    for (const path of list) {
      // 去掉目录、扩展名和结尾的字重后缀，得到字族名
      const base = path.split("/").pop()!.replace(/\.[^.]+$/, "");
      const family = base
        .replace(/[ _-]?(W\d{1,2}|Bold|SemiBold|ExtraBold|Medium|Regular|Light|ExtraLight|Thin|Heavy|[BHLMRSE])$/i, "")
        .trim() || base;
      if (!byFamily.has(family)) byFamily.set(family, path);
    }
    const uniq = [...byFamily.values()];
    if (uniq.length <= limit) return uniq;
    // 等距取样，保证开头中间结尾都能被模型看到
    const step = uniq.length / limit;
    return Array.from({ length: limit }, (_, i) => uniq[Math.floor(i * step)]);
  };

  const allFonts = collect(["fonts"], /\.(ttf|otf|ttc)$/i);
  const allBackgrounds = collect(["themes", "layouts", "bg", "backgrounds"], /\.(png|jpe?g|webp)$/i);
  const fonts = sample(allFonts, 70);
  const backgrounds = sample(allBackgrounds, 50);
  // 连续调整必须仍能看到当前资源，不能因均匀采样而无意清掉字体或背景。
  const keepCurrent = (list: string[], all: string[], value: unknown) => {
    if (typeof value === "string" && all.includes(value) && !list.includes(value)) list.push(value);
  };
  keepCurrent(fonts, allFonts, body?.current?.textFont);
  keepCurrent(backgrounds, allBackgrounds, body?.current?.bgImage);

  try {
    const { suggestTheme } = await import("../theme-ai");
    const suggestion = await suggestTheme(env, { prompt, fonts, backgrounds, current: body?.current && typeof body.current === "object" && !Array.isArray(body.current) ? body.current : undefined });
    return new Response(JSON.stringify({ ok: true, data: suggestion }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (e) {
    return err(`生成失败: ${(e as Error).message}`, 500);
  }
}
