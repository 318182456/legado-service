/**
 * 按一句话描述生成阅读主题配色。
 *
 * 复用 review-ai 的模型配置（system_config 里的 gemini_* 三项），
 * 同样支持 Gemini 原生与 OpenAI 兼容两种端点。
 *
 * 模型只负责出配色，字体/背景图从现有资源库里挑，不允许它编造文件名。
 */
import type { Env } from "./types";
import { loadAiConfig, detectProvider, type AiConfig } from "./review-ai";

export interface ThemeSuggestInput {
  /** 用户的一句话描述，如「护眼的墨绿色」 */
  prompt: string;
  /** 资源库里可选的字体，模型只能从中挑 */
  fonts: string[];
  /** 资源库里可选的背景图，模型只能从中挑 */
  backgrounds: string[];
}

export interface ThemeSuggestion {
  name: string;
  /** 日间 */
  bgStr: string;
  textColor: string;
  /** 夜间 */
  bgStrNight: string;
  textColorNight: string;
  /** 墨水屏 */
  bgStrEInk: string;
  textColorEInk: string;
  /** 从 fonts 里挑的一项，可为空表示不指定 */
  textFont: string;
  /** 从 backgrounds 里挑的一项，可为空表示纯色 */
  bgImage: string;
  /** 页眉页脚提示色（书名/章节名/进度）。留空表示跟随正文色 */
  tipColor: string;
  /** 模型给的一句话说明，展示给用户 */
  note: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function buildPrompt(input: ThemeSuggestInput): string {
  const fontList = input.fonts.length
    ? input.fonts.map((f, i) => `${i + 1}. ${f}`).join("\n")
    : "（无可用字体）";
  const bgList = input.backgrounds.length
    ? input.backgrounds.map((b, i) => `${i + 1}. ${b}`).join("\n")
    : "（无可用背景图）";

  return `你是阅读软件的配色设计师。用户的要求是：${input.prompt}

请配出一套阅读主题，包含日间、夜间、墨水屏三种状态的背景色与正文色。

硬性要求：
1. 颜色一律用 #RRGGBB 六位十六进制，不要带透明度。
2. 正文色与背景色的对比度必须达到 4.5:1 以上，保证长时间阅读不费眼。
3. 日间：浅底深字。夜间：深底浅字，背景要足够暗（建议亮度低于 #202020）。
   墨水屏：必须是纯白底 #FFFFFF 配纯黑字 #000000，这是墨水屏设备的硬性要求，不要改。
4. 三种状态要能看出是同一套主题的变体，色相上保持呼应。
5. tipColor 是页眉页脚上书名、章节名、页码、进度的颜色。它只有一个值，
   日间夜间共用，所以不要用只在某一种状态下才看得清的颜色。
   拿不准就填空字符串，那样会自动跟随正文色，这在三种状态下都不会出错。
   只有在你确信某个颜色在日间和夜间背景上都能看清时，才填具体值。
   特别注意：背景图的边角常常比中间暗，页脚文字压在上面很容易看不清。

可选字体（只能从下面挑一个，或留空字符串表示不指定）：
${fontList}

可选背景图（只能从下面挑一个，或留空字符串表示用纯色背景）：
${bgList}

注意：字体和背景图必须原样抄写上面列表里的完整路径，一个字都不能改，也不许自己编。
挑不到合适的就留空字符串。

name 给一个 2-6 字的中文主题名。note 用一句话说明配色思路。`;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    bgStr: { type: "string" },
    textColor: { type: "string" },
    bgStrNight: { type: "string" },
    textColorNight: { type: "string" },
    bgStrEInk: { type: "string" },
    textColorEInk: { type: "string" },
    textFont: { type: "string" },
    bgImage: { type: "string" },
    tipColor: { type: "string" },
    note: { type: "string" },
  },
  required: [
    "name", "bgStr", "textColor", "bgStrNight",
    "textColorNight", "bgStrEInk", "textColorEInk", "note",
  ],
};

/** 相对亮度，WCAG 定义 */
function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/** WCAG 对比度，1~21 */
export function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * 模型给的配色不一定达标，对比度不够时把正文色往黑或白推到及格为止。
 * 背景色保持不动，因为那是主题观感的主体。
 */
function ensureContrast(bg: string, text: string, min = 4.5): string {
  if (!HEX.test(bg) || !HEX.test(text)) return text;
  if (contrast(bg, text) >= min) return text;

  // 背景偏亮就把文字压暗，反之提亮
  const target = luminance(bg) > 0.5 ? "#000000" : "#FFFFFF";
  const tc = [1, 3, 5].map((i) => parseInt(text.slice(i, i + 2), 16));
  const gc = [1, 3, 5].map((i) => parseInt(target.slice(i, i + 2), 16));

  for (let step = 1; step <= 20; step++) {
    const r = step / 20;
    const mixed =
      "#" +
      tc.map((c, i) => Math.round(c + (gc[i] - c) * r).toString(16).padStart(2, "0")).join("");
    if (contrast(bg, mixed) >= min) return mixed;
  }
  return target;
}

/** 模型输出不可信，逐项校验后才交给前端 */
function normalize(raw: any, input: ThemeSuggestInput): ThemeSuggestion {
  const pick = (v: unknown, fallback: string) => {
    const s = typeof v === "string" ? v.trim() : "";
    return HEX.test(s) ? s : fallback;
  };

  const bgStr = pick(raw?.bgStr, "#EEEEEE");
  const bgStrNight = pick(raw?.bgStrNight, "#000000");

  // 字体和背景图必须真的在资源库里，否则一律丢弃
  const textFont = input.fonts.includes(String(raw?.textFont ?? "").trim())
    ? String(raw.textFont).trim()
    : "";
  const bgImage = input.backgrounds.includes(String(raw?.bgImage ?? "").trim())
    ? String(raw.bgImage).trim()
    : "";

  const name = String(raw?.name ?? "").trim().slice(0, 20) || "AI 主题";
  const note = String(raw?.note ?? "").trim().slice(0, 200);

  // tipColor 只有一个值、日夜共用，模型很容易给出只在一种状态下能看清的颜色。
  // Legado 在 tipColor 为 0 时会跟随正文色，而正文色本身是日夜感知的，
  // 所以只要模型给的颜色在日间或夜间任一侧对比度不达标，就退回跟随。
  // 背景是图片时无从判断底色深浅，一律跟随，避免压在深色图上看不清。
  let tipColor = "";
  const tipRaw = typeof raw?.tipColor === "string" ? raw.tipColor.trim() : "";
  if (HEX.test(tipRaw) && !bgImage) {
    const okDay = contrast(bgStr, tipRaw) >= 3;
    const okNight = contrast(bgStrNight, tipRaw) >= 3;
    if (okDay && okNight) tipColor = tipRaw;
  }

  return {
    name,
    bgStr,
    tipColor,
    textColor: ensureContrast(bgStr, pick(raw?.textColor, "#3E3D3B")),
    bgStrNight,
    textColorNight: ensureContrast(bgStrNight, pick(raw?.textColorNight, "#ADADAD")),
    // 墨水屏固定黑白，不接受模型改动
    bgStrEInk: "#FFFFFF",
    textColorEInk: "#000000",
    textFont,
    bgImage,
    note,
  };
}

export async function suggestTheme(
  env: Env,
  input: ThemeSuggestInput,
): Promise<ThemeSuggestion> {
  const cfg = await loadAiConfig(env);
  if (!cfg.apiKey) throw new Error("未配置模型 API Key");

  const text = await callModel(cfg, buildPrompt(input));

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`模型返回的不是合法 JSON：${text.slice(0, 200)}`);
  }
  return normalize(parsed, input);
}

async function callModel(cfg: AiConfig, prompt: string): Promise<string> {
  if (detectProvider(cfg) === "openai-compatible") {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.9,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "只输出 JSON，字段为 name/bgStr/textColor/bgStrNight/textColorNight/" +
              "bgStrEInk/textColorEInk/textFont/bgImage/note，不要加解释或代码块围栏。",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`模型接口 HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as any;
    return data?.choices?.[0]?.message?.content ?? "";
  }

  const url =
    `${cfg.baseUrl}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent` +
    `?key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.9,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as any;
  return data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
}
