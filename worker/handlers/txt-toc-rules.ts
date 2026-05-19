import { Env } from "../types";
import {
  ok,
  err,
  parseBody,
  rebuildCache,
  hashText
} from "../utils";

export async function handleListTxtTocRules(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get("q") || "";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const limit = 10;
  const offset = (page - 1) * limit;

  const [countRow, listResult] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as cnt FROM txt_toc_rules WHERE name LIKE ?`).bind(`%${q}%`).first() as Promise<{ cnt: number }>,
    env.DB.prepare(`SELECT * FROM txt_toc_rules WHERE name LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?`).bind(`%${q}%`, limit, offset).all(),
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

export async function handleAddTxtTocRule(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ name: string; rule: string; example?: string; serialNumber?: number }>(request);
  if (!body?.name || !body?.rule) return err("名称和模式不能为空");

  let manualSub = (await env.DB.prepare("SELECT id FROM subscriptions WHERE url = 'manual_txt_toc_rules'").first()) as any;
  if (!manualSub) {
    const { meta } = await env.DB.prepare("INSERT INTO subscriptions (name, url, type) VALUES ('手动添加目录规则', 'manual_txt_toc_rules', 'txtTocRule')").run();
    manualSub = { id: meta.last_row_id };
  }

  const enabled = 1;
  const serialNumber = body.serialNumber ?? -1;
  const example = body.example || null;

  const rawJson = JSON.stringify({
    name: body.name,
    rule: body.rule,
    example: example,
    serialNumber: serialNumber,
    enable: true
  });

  const ruleHash = await hashText(body.rule);

  await env.DB.prepare(
    `INSERT INTO txt_toc_rules (subscription_id, name, rule, example, serial_number, enabled, raw_json, rule_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(manualSub.id, body.name, body.rule, example, serialNumber, enabled, rawJson, ruleHash).run();

  await rebuildCache(env, "txtTocRule");
  return ok();
}

export async function handleTxtTocRuleAction(env: Env, id: number, action: string, request?: Request): Promise<Response> {
  if (action === "delete") {
    await env.DB.prepare("DELETE FROM txt_toc_rules WHERE id = ?").bind(id).run();
  } else if (action === "toggle" && request) {
    const { enabled } = await request.json() as { enabled: number };
    await env.DB.prepare("UPDATE txt_toc_rules SET enabled = ? WHERE id = ?").bind(enabled, id).run();
    
    const rule = await env.DB.prepare("SELECT raw_json FROM txt_toc_rules WHERE id = ?").bind(id).first() as any;
    if (rule) {
      try {
        const json = JSON.parse(rule.raw_json);
        json.enable = !!enabled;
        await env.DB.prepare("UPDATE txt_toc_rules SET raw_json = ? WHERE id = ?").bind(JSON.stringify(json), id).run();
      } catch (e) {}
    }
  } else if (action === "update" && request) {
    const body = await request.json() as { name: string; rule: string; example?: string; serialNumber?: number };
    if (!body.name || !body.rule) return err("名称和模式不能为空");

    const serialNumber = body.serialNumber ?? -1;
    const example = body.example || null;

    const rawJson = JSON.stringify({
      name: body.name,
      rule: body.rule,
      example: example,
      serialNumber: serialNumber,
      enable: true
    });

    const ruleHash = await hashText(body.rule);

    await env.DB.prepare(
      `UPDATE txt_toc_rules SET name = ?, rule = ?, example = ?, serial_number = ?, raw_json = ?, rule_hash = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(body.name, body.rule, example, serialNumber, rawJson, ruleHash, id).run();
  }
  
  await rebuildCache(env, "txtTocRule");
  return ok();
}

export async function handleImportTxtTocRules(request: Request, env: Env): Promise<Response> {
  const body = await parseBody<{ rules: any[] }>(request);
  const rulesArray = body?.rules;
  if (!Array.isArray(rulesArray) || rulesArray.length === 0) return err("无有效规则数据");

  let manualSub = (await env.DB.prepare("SELECT id FROM subscriptions WHERE url = 'manual_txt_toc_rules'").first()) as any;
  if (!manualSub) {
    const { meta } = await env.DB.prepare("INSERT INTO subscriptions (name, url, type) VALUES ('手动添加目录规则', 'manual_txt_toc_rules', 'txtTocRule')").run();
    manualSub = { id: meta.last_row_id };
  }

  const subId = manualSub.id;
  let count = 0;
  const BATCH = 50;

  for (let i = 0; i < rulesArray.length; i += BATCH) {
    const chunk = rulesArray.slice(i, i + BATCH);
    const stmts = chunk.map(async (rule) => {
      const name = String(rule.name ?? "").trim();
      const rulePattern = String(rule.rule ?? "").trim();
      if (!name || !rulePattern) return null;

      const example = rule.example ? String(rule.example) : null;
      const serialNumber = Number(rule.serialNumber ?? rule.serial_number ?? -1);
      const enabled = rule.enable ?? rule.enabled ?? true ? 1 : 0;
      
      const normalizedRule = {
        ...rule,
        name,
        rule: rulePattern,
        example,
        serialNumber,
        enable: !!enabled
      };
      
      const rawJson = JSON.stringify(normalizedRule);
      const ruleHash = await hashText(rulePattern);

      return env.DB.prepare(
        `INSERT INTO txt_toc_rules (subscription_id, name, rule, example, serial_number, enabled, raw_json, rule_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(subscription_id, name, rule_hash)
         DO UPDATE SET example=excluded.example, serial_number=excluded.serial_number,
                       enabled=excluded.enabled, raw_json=excluded.raw_json, updated_at=excluded.updated_at`
      ).bind(subId, name, rulePattern, example, serialNumber, enabled, rawJson, ruleHash);
    });

    const resolvedStmts = (await Promise.all(stmts)).filter(x => x !== null) as any[];
    if (resolvedStmts.length > 0) {
      await env.DB.batch(resolvedStmts);
      count += resolvedStmts.length;
    }
  }

  // 更新订阅计数
  await env.DB.prepare(
    `UPDATE subscriptions SET last_synced=datetime('now'), item_count=(SELECT COUNT(*) FROM txt_toc_rules WHERE subscription_id=?) WHERE id=?`
  ).bind(subId, subId).run();

  await rebuildCache(env, "txtTocRule");
  return ok({ imported: count });
}
