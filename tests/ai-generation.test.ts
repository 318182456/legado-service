import assert from "node:assert/strict";
import { test } from "node:test";
import { generateJson } from "../worker/ai-client";
import { createGenerator, normalizeDrafts, type AiConfig } from "../worker/review-ai";
import { contrast, normalizeTheme, suggestTheme } from "../worker/theme-ai";
import type { Env } from "../worker/types";

const cfg: AiConfig = {
  provider: "auto", baseUrl: "https://model.invalid/v1", apiKey: "test-key", model: "test-model",
  personas: [], density: 3, hotspots: 3, replyDepth: 2, maxParaChars: 1200,
};
const input = { prompt: "温暖纸张", fonts: ["fonts/test.ttf"], backgrounds: ["bg/paper.png"] };
const colors = { bgStr: "#EDE8DA", textColor: "#333333", bgStrNight: "#151410", textColorNight: "#AAAAAA" };
const env = {
  DB: { prepare: () => ({ all: async () => ({ results: [
    { key: "gemini_api_key", value: cfg.apiKey }, { key: "gemini_base_url", value: cfg.baseUrl },
  ] }) }) },
} as unknown as Env;
const completion = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: "stop" }] });

test("正文对比度修正在全部灰阶背景上达到 4.5，保留背景色", () => {
  for (let i = 0; i < 256; i++) {
    const bg = "#" + i.toString(16).padStart(2, "0").repeat(3);
    const theme = normalizeTheme({ bgStr: bg, textColor: bg, bgStrNight: bg, textColorNight: bg }, input);
    assert.equal(theme.bgStr, bg);
    assert.ok(contrast(bg, theme.textColor) >= 4.5, `${bg} / ${theme.textColor}`);
    assert.ok(contrast(bg, theme.textColorNight) >= 4.5);
  }
});

test("排版 null/空串/布尔值使用默认值，拒绝虚构资源，固定墨水屏黑白", () => {
  const theme = normalizeTheme({ ...colors, textSize: null, lineSpacingExtra: "", paddingLeft: null,
    paddingRight: false, letterSpacing: null, textFont: "invented.ttf", bgImage: "invented.png",
    bgStrEInk: "#444444", textColorEInk: "#EEEEEE" }, input);
  assert.equal(theme.textSize, 22);
  assert.equal(theme.lineSpacingExtra, 16);
  assert.equal(theme.paddingLeft, 16);
  assert.equal(theme.paddingRight, 16);
  assert.equal(theme.letterSpacing, 0.05);
  assert.equal(theme.textFont, "");
  assert.equal(theme.bgImage, "");
  assert.equal(theme.bgStrEInk, "#FFFFFF");
  assert.equal(theme.textColorEInk, "#000000");
});

test("图片背景与日夜不可共用的提示色回退到跟随正文", () => {
  assert.equal(normalizeTheme({ ...colors, tipColor: "#333333" }, input).tipColor, "");
  assert.equal(normalizeTheme({ ...colors, bgImage: "bg/paper.png", tipColor: "#777777" }, input).tipColor, "");
});

test("段评过滤错段号和非文本，按内容去重并限制主评数及回复总数", () => {
  const result = normalizeDrafts([
    { paraIndex: 0, content: "错误段号" }, { paraIndex: 4, content: "越界" },
    { paraIndex: true, content: "错误类型" }, { paraIndex: 1, content: {} },
    { paraIndex: 1, author: "甲", content: "这刀竟然没拔！", replies: [
      { author: "乙", content: "手一直在抖", replies: [{ content: "原来是害怕" }, { content: "多余回复" }] },
      { content: "还要更多" },
    ] },
    { paraIndex: 2, content: "这刀竟然没拔" },
    { paraIndex: -1, content: "这标题有点意思" },
    { paraIndex: 2, content: "超过密度上限" },
  ], 3, 2, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].paraIndex, 1);
  assert.deepEqual(result[0].replies?.map(r => r.content), ["手一直在抖", "原来是害怕"]);
  assert.equal(result[1].paraIndex, -1);
});

test("兼容端点解析 JSON 围栏，发送排版字段说明且附带可取消的超时信号", async t => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://model.invalid/v1/chat/completions");
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body as string);
    assert.match(body.messages[0].content, /textSize/);
    assert.match(body.messages[0].content, /tipColor/);
    return Response.json({ choices: [{ message: { content: "```json\n" + JSON.stringify(colors) + "\n```" } }] });
  });
  const theme = await suggestTheme(env, input);
  assert.equal(theme.bgStr, colors.bgStr);
});

test("Gemini 使用独立密钥请求头，忽略思考内容并解析真实 JSON", async t => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://model.invalid/v1beta/models/test-model:generateContent");
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "test-key");
    return Response.json({ candidates: [{ content: { parts: [{ thought: true, text: "思考" }, { text: '{"ok":true}' }] }, finishReason: "STOP" }] });
  });
  assert.deepEqual(await generateJson({ ...cfg, baseUrl: "https://model.invalid", provider: "gemini" }, "test", { properties: {} }, 0.6), { ok: true });
});

test("空响应、输出截断、无效 JSON 和错误结构均失败，不生成伪成功结果", async t => {
  const cases = [
    { choices: [] },
    { choices: [{ message: { content: '{"reviews":[]}' }, finish_reason: "length" }] },
    { choices: [{ message: { content: "sorry" } }] },
    { choices: [{ message: { content: "null" } }] },
    { choices: [{ message: { content: "[]" } }] },
  ];
  for (const response of cases) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json(response));
    await assert.rejects(generateJson(cfg, "test", { properties: {} }, 0.6));
    mock.mock.restore();
  }
});

test("上游异常不向用户回显响应中的凭据", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("secret-token-123", { status: 429 }));
  await assert.rejects(generateJson(cfg, "test", { properties: {} }, 0.6), e => {
    assert.match((e as Error).message, /429/);
    assert.doesNotMatch((e as Error).message, /secret-token/);
    return true;
  });
});

test("段评请求保留长段末尾和原始编号，空有效段评报错以供重试", async t => {
  const args = { bookName: "测试", author: "", chapterTitle: "一", paragraphs: ["开头" + "文".repeat(1800) + "结尾反转", "第二段"], density: 2, hotspots: 10, personas: [], replyDepth: 2 };
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const prompt = JSON.parse(init.body as string).messages[1].content;
    assert.match(prompt, /结尾反转/);
    assert.match(prompt, /\[2\] 第二段/);
    assert.match(prompt, /最多 2 个/);
    return completion({ reviews: [] });
  });
  await assert.rejects(createGenerator(cfg).generate(args), /没有生成有效段评/);
});

test("主题调整带入当前排版，缺少配色不再用默认值冒充生成成功", async t => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const prompt = JSON.parse(init.body as string).messages[1].content;
    assert.match(prompt, /"textSize":28/);
    assert.match(prompt, /"lineSpacingExtra":16/);
    return completion({ name: "空方案" });
  });
  await assert.rejects(suggestTheme(env, { ...input, current: { textSize: 28, lineSpacingExtra: 16 } }), /未返回完整配色/);
});
