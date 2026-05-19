import { Env } from "../types";
import {
  ok,
  err,
  parseBody,
  rebuildCache
} from "../utils";

export async function handleListDictRules(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = 20;
  const offset = (page - 1) * limit;

  const [countRow, listResult] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM dict_rules WHERE name LIKE ?`).bind(`%${q}%`).first() as Promise<{ cnt: number }>,
    env.DB.prepare(`SELECT * FROM dict_rules WHERE name LIKE ? ORDER BY sort_number ASC, id DESC LIMIT ? OFFSET ?`).bind(`%${q}%`, limit, offset).all(),
  ]);

  const total = (countRow as any)?.cnt ?? 0;
  return ok({
    rules: listResult.results,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    page,
    limit,
  });
}

export async function handleAddDictRule(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ name: string; urlRule: string; showRule?: string; sortNumber?: number }>(request);
  if (!body?.name || !body?.urlRule) return err("名称和查询规则不能为空");

  let manualSub = (await env.DB.prepare("SELECT id FROM subscriptions WHERE url = 'manual_dict_rules'").first()) as any;
  if (!manualSub) {
    const { meta } = await env.DB.prepare("INSERT INTO subscriptions (name, url, type) VALUES ('手动添加字典规则', 'manual_dict_rules', 'dictRule')").run();
    manualSub = { id: meta.last_row_id };
  }

  const enabled = 1;
  const sortNumber = body.sortNumber ?? 0;
  const showRule = body.showRule || "";

  const rawJson = JSON.stringify({
    name: body.name,
    urlRule: body.urlRule,
    showRule: showRule,
    sortNumber: sortNumber,
    enabled: true
  });

  await env.DB.prepare(
    `INSERT INTO dict_rules (subscription_id, name, url_rule, show_rule, enabled, sort_number, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(manualSub.id, body.name, body.urlRule, showRule, enabled, sortNumber, rawJson).run();

  await rebuildCache(env, "dictRule");
  return ok();
}

export async function handleDictRuleAction(env: Env, id: number, action: string, request?: Request): Promise<Response> {
  if (action === "delete") {
    await env.DB.prepare("DELETE FROM dict_rules WHERE id = ?").bind(id).run();
  } else if (action === "toggle" && request) {
    const { enabled } = await request.json() as { enabled: number };
    await env.DB.prepare("UPDATE dict_rules SET enabled = ? WHERE id = ?").bind(enabled, id).run();
    
    const rule = await env.DB.prepare("SELECT raw_json FROM dict_rules WHERE id = ?").bind(id).first() as any;
    if (rule) {
      try {
        const json = JSON.parse(rule.raw_json);
        json.enabled = !!enabled;
        await env.DB.prepare("UPDATE dict_rules SET raw_json = ? WHERE id = ?").bind(JSON.stringify(json), id).run();
      } catch (e) {}
    }
  } else if (action === "update" && request) {
    const body = await request.json() as { name: string; urlRule: string; showRule?: string; sortNumber?: number };
    if (!body.name || !body.urlRule) return err("名称和查询规则不能为空");

    const sortNumber = body.sortNumber ?? 0;
    const showRule = body.showRule || "";

    const rawJson = JSON.stringify({
      name: body.name,
      urlRule: body.urlRule,
      showRule: showRule,
      sortNumber: sortNumber,
      enabled: true
    });

    await env.DB.prepare(
      `UPDATE dict_rules SET name = ?, url_rule = ?, show_rule = ?, sort_number = ?, raw_json = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(body.name, body.urlRule, showRule, sortNumber, rawJson, id).run();
  }
  
  await rebuildCache(env, "dictRule");
  return ok();
}

export async function handleImportDictRules(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ rules: any[] }>(request);
  const rulesArray = body?.rules;
  if (!Array.isArray(rulesArray) || rulesArray.length === 0) return err("无有效规则数据");

  let manualSub = (await env.DB.prepare("SELECT id FROM subscriptions WHERE url = 'manual_dict_rules'").first()) as any;
  if (!manualSub) {
    const { meta } = await env.DB.prepare("INSERT INTO subscriptions (name, url, type) VALUES ('手动添加字典规则', 'manual_dict_rules', 'dictRule')").run();
    manualSub = { id: meta.last_row_id };
  }

  const subId = manualSub.id;
  let count = 0;
  const BATCH = 50;

  for (let i = 0; i < rulesArray.length; i += BATCH) {
    const chunk = rulesArray.slice(i, i + BATCH);
    const stmts = chunk.map((rule) => {
      const name = String(rule.name ?? "").trim();
      const urlRule = String(rule.urlRule ?? rule.url_rule ?? "").trim();
      if (!name || !urlRule) return null;

      const showRule = String(rule.showRule ?? rule.show_rule ?? "");
      const sortNumber = Number(rule.sortNumber ?? rule.sort_number ?? 0);
      const enabled = rule.enabled ?? rule.enable ?? true ? 1 : 0;
      
      const normalizedRule = {
        ...rule,
        name,
        urlRule,
        showRule,
        sortNumber,
        enabled: !!enabled
      };
      
      const rawJson = JSON.stringify(normalizedRule);

      return env.DB.prepare(
        `INSERT INTO dict_rules (subscription_id, name, url_rule, show_rule, enabled, sort_number, raw_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(subscription_id, name)
         DO UPDATE SET url_rule=excluded.url_rule, show_rule=excluded.show_rule,
                       enabled=excluded.enabled, sort_number=excluded.sort_number,
                       raw_json=excluded.raw_json, updated_at=excluded.updated_at`
      ).bind(subId, name, urlRule, showRule, enabled, sortNumber, rawJson);
    });

    const resolvedStmts = stmts.filter(x => x !== null) as any[];
    if (resolvedStmts.length > 0) {
      await env.DB.batch(resolvedStmts);
      count += resolvedStmts.length;
    }
  }

  // 更新订阅计数
  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=(SELECT COUNT(*) FROM dict_rules WHERE subscription_id=?) WHERE id=?`
  ).bind(subId, subId).run();

  await rebuildCache(env, "dictRule");
  return ok({ imported: count });
}
