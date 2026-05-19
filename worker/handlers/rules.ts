import { Env } from "../types";
import {
  ok,
  err,
  parseBody,
  rebuildCache,
} from "../utils";

export async function handleListRules(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = 50;
  const offset = (page - 1) * limit;
  const { results } = await env.DB.prepare(
    `SELECT * FROM rules WHERE name LIKE ? LIMIT ? OFFSET ?`
  ).bind(`%${q}%`, limit, offset).all();
  return ok(results);
}

export async function handleAddRule(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ name: string; pattern: string; replacement: string; group?: string }>(request);
  if (!body?.name || !body?.pattern) return err("名称和模式不能为空");

  let manualSub = (await env.DB.prepare("SELECT id FROM subscriptions WHERE url = 'manual_rules'").first()) as any;
  if (!manualSub) {
    const { meta } = await env.DB.prepare("INSERT INTO subscriptions (name, url, type) VALUES ('手动添加规则', 'manual_rules', 'rule')").run();
    manualSub = { id: meta.last_row_id };
  }

  const rawJson = JSON.stringify({
    name: body.name,
    group: body.group || "手动添加",
    pattern: body.pattern,
    replacement: body.replacement || "",
    isRegex: true,
    isEnabled: true,
    ruleType: 0
  });

  await env.DB.prepare(
    "INSERT INTO rules (subscription_id, name, pattern, replacement, raw_json) VALUES (?, ?, ?, ?, ?)"
  ).bind(manualSub.id, body.name, body.pattern, body.replacement || "", rawJson).run();

  await rebuildCache(env, "rule");
  return ok();
}

export async function handleRuleAction(env: Env, id: number, action: string, request?: Request): Promise<Response> {
  if (action === "delete") {
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
  } else if (action === "toggle" && request) {
    const { enabled } = await request.json() as { enabled: number };
    await env.DB.prepare("UPDATE rules SET enabled = ? WHERE id = ?").bind(enabled, id).run();
    
    // 同步更新 raw_json 中的 isEnabled 字段
    const rule = await env.DB.prepare("SELECT raw_json FROM rules WHERE id = ?").bind(id).first() as any;
    if (rule) {
      try {
        const json = JSON.parse(rule.raw_json);
        json.isEnabled = !!enabled;
        await env.DB.prepare("UPDATE rules SET raw_json = ? WHERE id = ?").bind(JSON.stringify(json), id).run();
      } catch (e) {}
    }
  } else if (action === "update" && request) {
    const body = await request.json() as { name: string; pattern: string; replacement: string; group?: string };
    if (!body.name || !body.pattern) return err("名称和模式不能为空");

    const rawJson = JSON.stringify({
      name: body.name,
      group: body.group || "手动添加",
      pattern: body.pattern,
      replacement: body.replacement || "",
      isRegex: true,
      isEnabled: true,
      ruleType: 0
    });

    await env.DB.prepare(
      "UPDATE rules SET name = ?, pattern = ?, replacement = ?, raw_json = ? WHERE id = ?"
    ).bind(body.name, body.pattern, body.replacement || "", rawJson, id).run();
  }
  
  await rebuildCache(env, "rule");
  return ok();
}
