import { Env } from "../types";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { rebuildCache } from "../utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_STR = fs.readFileSync(path.join(__dirname, "subscribe.html"), "utf-8");

/** 将 handleSubscribeOutput 的类型参数映射到 rebuildCache 的类型参数 */
const TYPE_MAP = {
  sources: "source",
  rules: "rule",
  txtTocRules: "txtTocRule",
  dictRules: "dictRule",
} as const;

export async function handleSubscribeOutput(env: Env, type: keyof typeof TYPE_MAP): Promise<Response> {
  try {
    const cacheKey = type === "sources" ? "sources" : type === "rules" ? "rules" : type === "txtTocRules" ? "txtTocRules" : "dictRules";
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" },
      });
    }

    // 缓存 MISS：调用 rebuildCache 重建并写入 KV，再读取返回（消除重复 SQL）
    await rebuildCache(env, TYPE_MAP[type]);
    const fresh = await env.KV.get(cacheKey);
    const jsonArray = fresh ?? "[]";

    return new Response(jsonArray, {
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

function getRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");
  const host = request.headers.get("x-forwarded-host") || url.host;
  return `${proto}://${host}`;
}

export async function handleSubscribeIndex(request: Request, env: Env): Promise<Response> {
  const origin = getRequestOrigin(request);
  
  let html = TEMPLATE_STR;

  // 动态注入变量 (仅保留基础 URL)
  html = html
    .replace(/{{ORIGIN}}/g, origin)
    .replace(/{{SOURCES_URL}}/g, encodeURIComponent(origin + '/subscribe/sources'))
    .replace(/{{RULES_URL}}/g, encodeURIComponent(origin + '/subscribe/rules'))
    .replace(/{{TXT_TOC_RULES_URL}}/g, encodeURIComponent(origin + '/subscribe/txtTocRules'))
    .replace(/{{DICT_RULES_URL}}/g, encodeURIComponent(origin + '/subscribe/dictRules'))
    .replace(/{{INFO_URL}}/g, encodeURIComponent(origin + '/subscribe/info.json'))
    .replace(/{{RSS_ALL_URL}}/g, encodeURIComponent(origin + '/repo/mochen_sources.json'));

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}

export function handleSubscribeInfo(request: Request): Response {
  const origin = getRequestOrigin(request);
  const icon = `${origin}/repo/logo.png`;
  const source = [{
    "sourceName": "订阅中心",
    "sourceUrl": `${origin}/subscribe/index`,
    "sourceIcon": icon,
    "sourceGroup": "整合",
    "articleStyle": 0,
    "enableJs": true,
    "enabled": true,
    "enabledCookieJar": false,
    "loadWithBaseUrl": true,
    "singleUrl": true,
    "header": JSON.stringify({ "User-Agent": "Mozilla/5.0 (Linux; U; Android 8.1.0; zh-CN; MI 8 Lite Build/OPM1.171019.019) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.2.0.1100 Mobile Safari/537.36" }),
    "sortUrl": `首页::${origin}/subscribe/index`,
    "ruleArticles": "#tab-0 h3",
    "ruleTitle": "a@text",
    "ruleLink": "a@href",
    "ruleImage": "img@src",
    "type": 0
  }];
  return new Response(JSON.stringify(source), { headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
}

export async function handleListRssSources(env: Env): Promise<Response> {
  try {
    const object = await env.ASSETS_R2.get("mochen_sources.json");
    if (!object) {
      return new Response(JSON.stringify({ ok: true, data: [] }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }
    const text = await object.text();
    const data = JSON.parse(text);
    const list = data.map((item: any, index: number) => ({
      index,
      sourceName: item.sourceName || "未命名订阅源",
      sourceGroup: item.sourceGroup || "无分组",
      sourceIcon: item.sourceIcon || "",
      sourceUrl: item.sourceUrl || "",
      enabled: item.enabled !== false
    }));
    return new Response(JSON.stringify({ ok: true, data: list }), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }
}

export async function handleExportRssSource(env: Env, indexStr: string): Promise<Response> {
  try {
    const index = parseInt(indexStr, 10);
    const object = await env.ASSETS_R2.get("mochen_sources.json");
    if (!object) {
      return new Response(JSON.stringify({ error: "mochen_sources.json not found" }), { status: 404 });
    }
    const text = await object.text();
    const data = JSON.parse(text);
    if (isNaN(index) || index < 0 || index >= data.length) {
      return new Response(JSON.stringify({ error: "Index out of bounds" }), { status: 400 });
    }
    const singleSource = data[index];
    return new Response(JSON.stringify([singleSource]), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500 });
  }
}

export async function handleToggleRssSource(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as any;
    const { index, enabled } = body;
    if (typeof index !== "number") {
      return new Response(JSON.stringify({ ok: false, error: "index is required and must be a number" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    const object = await env.ASSETS_R2.get("mochen_sources.json");
    if (!object) {
      return new Response(JSON.stringify({ ok: false, error: "mochen_sources.json not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    const text = await object.text();
    const data = JSON.parse(text);
    if (index < 0 || index >= data.length) {
      return new Response(JSON.stringify({ ok: false, error: "Index out of bounds" }), {
        status: 400,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }

    data[index].enabled = !!enabled;

    // Save changes back to R2/local assets directory
    await env.ASSETS_R2.put("mochen_sources.json", JSON.stringify(data, null, 2));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
}


