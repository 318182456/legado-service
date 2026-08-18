/**
 * 段评生成层
 *
 * 生成器以 provider 形式抽象，换模型只需新增一个实现并在 createGenerator 里登记。
 * Gemini 走 REST，不引入 SDK 依赖，Node 与 Worker 运行时通用。
 */

import { Env } from "./types";

// ─── 类型 ─────────────────────────────────────────────────────────

export interface ReviewDraft {
  /** 段落序号，1 起；-1 表示章节标题 */
  paraIndex: number;
  author: string;
  content: string;
  replies?: { author: string; content: string }[];
}

export interface GenerateInput {
  bookName: string;
  author: string;
  chapterTitle: string;
  /** 净化后的正文段落，下标 0 即第 1 段 */
  paragraphs: string[];
  /** 本章期望生成的主评论条数 */
  density: number;
  personas: string[];
}

export interface ReviewGenerator {
  readonly name: string;
  generate(input: GenerateInput): Promise<ReviewDraft[]>;
}

export interface AiConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  personas: string[];
  density: number;
  /** 单段落最长送入模型的字数，超出则截断 */
  maxParaChars: number;
}

// ─── 配置 ─────────────────────────────────────────────────────────

export const DEFAULT_PERSONAS = [
  "毒舌吐槽役：一句话戳破套路，语气欠但不刻薄",
  "剧情党：顺着伏笔猜后续，爱说“我赌五毛”",
  "考据党：抠设定和前文细节，偶尔纠正作者",
  "情绪型：只会“啊啊啊”“破防了”“这段封神”这类短句",
  "老读者：拿作者别的书或同类桥段作比较",
];

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

export async function loadAiConfig(env: Env): Promise<AiConfig> {
  const rows = await env.DB.prepare("SELECT key, value FROM system_config").all();
  const cfg: Record<string, string> = {};
  for (const r of (rows.results ?? []) as any[]) cfg[r.key] = r.value ?? "";

  let personas = DEFAULT_PERSONAS;
  if (cfg["review_personas"]) {
    const parsed = cfg["review_personas"]
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length) personas = parsed;
  }

  const density = Number(cfg["review_density"] || "6");

  return {
    // auto 时按 base URL 形态自动判断，见 detectProvider
    provider: cfg["review_ai_provider"] || "auto",
    apiKey: cfg["gemini_api_key"] || "",
    model: cfg["gemini_model"] || DEFAULT_MODEL,
    baseUrl: (cfg["gemini_base_url"] || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    personas,
    density: Number.isFinite(density) ? Math.min(20, Math.max(1, density)) : 6,
    maxParaChars: 400,
  };
}

// ─── Prompt ───────────────────────────────────────────────────────

function buildPrompt(input: GenerateInput, maxParaChars: number): string {
  const numbered = input.paragraphs
    .map((p, i) => {
      const text = p.length > maxParaChars ? p.slice(0, maxParaChars) + "…" : p;
      return `[${i + 1}] ${text}`;
    })
    .join("\n");

  return `你在为一款小说阅读器生成"段评"——读者读到某一段时顺手发的即时评论。

书名：《${input.bookName}》${input.author ? `　作者：${input.author}` : ""}
章节：${input.chapterTitle}

正文段落（方括号内是段落序号）：
${numbered}

请挑出本章最值得评论的 ${input.density} 个段落，各写 1 条评论。要求：

1. 只评论真正有反应点的段落——反转、名场面、埋伏笔、角色高光或明显的槽点。平淡的过渡段不要评。
2. 每条评论 10 到 40 字，口语化，像手机上随手打的。不要书面语，不要"这段描写生动地体现了"这种腔调。
3. 评论要针对那一段的具体内容，不能是放之四海皆准的空话。
4. 按下列人设分配评论者，author 字段直接写人设的称呼（自己起个像网名的短名字，不要带冒号和说明）：
${input.personas.map((p) => `   - ${p}`).join("\n")}
5. 其中 1 到 2 条可以带 1 条回复，模拟其他读者接话或抬杠。
6. paraIndex 必须是上面出现过的段落序号。评论章节标题用 -1。
7. 全部使用简体中文。不要使用 Markdown，不要加引号包裹。`;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          paraIndex: { type: "integer" },
          author: { type: "string" },
          content: { type: "string" },
          replies: {
            type: "array",
            items: {
              type: "object",
              properties: {
                author: { type: "string" },
                content: { type: "string" },
              },
              required: ["author", "content"],
            },
          },
        },
        required: ["paraIndex", "author", "content"],
      },
    },
  },
  required: ["reviews"],
};

// ─── Gemini ───────────────────────────────────────────────────────

class GeminiGenerator implements ReviewGenerator {
  readonly name = "gemini";

  constructor(private cfg: AiConfig) {}

  async generate(input: GenerateInput): Promise<ReviewDraft[]> {
    const url =
      `${this.cfg.baseUrl}/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent` +
      `?key=${encodeURIComponent(this.cfg.apiKey)}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildPrompt(input, this.cfg.maxParaChars) }] }],
        generationConfig: {
          temperature: 1.0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
        safetySettings: [
          "HARM_CATEGORY_HARASSMENT",
          "HARM_CATEGORY_HATE_SPEECH",
          "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          "HARM_CATEGORY_DANGEROUS_CONTENT",
        ].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" })),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as any;
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? "").join("") ?? "";
    if (!text.trim()) {
      const reason = data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? "空响应";
      throw new Error(`Gemini 未返回内容：${reason}`);
    }

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Gemini 返回的不是合法 JSON：${text.slice(0, 200)}`);
    }

    return normalizeDrafts(parsed?.reviews, input.paragraphs.length);
  }
}

/** 模型输出不可信，逐条校验后才允许入库 */
function normalizeDrafts(raw: unknown, paraCount: number): ReviewDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewDraft[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    const paraIndex = Number(r.paraIndex);
    if (!Number.isInteger(paraIndex)) continue;
    if (paraIndex !== -1 && (paraIndex < 1 || paraIndex > paraCount)) continue;

    const content = String(r.content ?? "").trim();
    if (!content) continue;

    const author = String(r.author ?? "").trim().slice(0, 24) || "书友";

    const replies: { author: string; content: string }[] = [];
    if (Array.isArray(r.replies)) {
      for (const rep of r.replies) {
        if (!rep || typeof rep !== "object") continue;
        const repContent = String((rep as any).content ?? "").trim();
        if (!repContent) continue;
        replies.push({
          author: String((rep as any).author ?? "").trim().slice(0, 24) || "书友",
          content: repContent.slice(0, 200),
        });
      }
    }

    out.push({ paraIndex, author, content: content.slice(0, 300), replies });
  }

  return out;
}

// ─── OpenAI 兼容 ──────────────────────────────────────────────────

/**
 * 大量中转与自建代理只提供 OpenAI 兼容端点（/v1/chat/completions），
 * 用原生 Gemini 的 /v1beta/models/x:generateContent 打过去必然 404。
 * base URL 以 /v1 结尾时基本就是这种，见 detectProvider。
 */
class OpenAiCompatibleGenerator implements ReviewGenerator {
  readonly name = "openai-compatible";

  constructor(private cfg: AiConfig) {}

  async generate(input: GenerateInput): Promise<ReviewDraft[]> {
    const url = `${this.cfg.baseUrl}/chat/completions`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 1.0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              '只输出 JSON，形如 {"reviews":[{"paraIndex":1,"author":"网名","content":"评论",' +
              '"replies":[{"author":"网名","content":"回复"}]}]}，不要加解释或代码块围栏。',
          },
          { role: "user", content: buildPrompt(input, this.cfg.maxParaChars) },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`模型接口 HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data = (await res.json()) as any;
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!String(text).trim()) {
      throw new Error(`模型未返回内容：${data?.choices?.[0]?.finish_reason ?? "空响应"}`);
    }

    let parsed: any;
    try {
      // 有些服务无视 response_format，仍会套 ```json 围栏
      parsed = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
    } catch {
      throw new Error(`模型返回的不是合法 JSON：${String(text).slice(0, 200)}`);
    }

    return normalizeDrafts(parsed?.reviews, input.paragraphs.length);
  }
}

// ─── 工厂 ─────────────────────────────────────────────────────────

/**
 * provider 配成 auto（默认）时按 base URL 猜：
 * 以 /v1 结尾的是 OpenAI 兼容端点，其余按原生 Gemini 处理。
 */
export function detectProvider(cfg: AiConfig): string {
  if (cfg.provider && cfg.provider !== "auto") return cfg.provider;
  return /\/v1$/.test(cfg.baseUrl) ? "openai-compatible" : "gemini";
}

/** 最终会请求的完整地址，诊断时展示出来便于核对 */
export function describeEndpoint(cfg: AiConfig): string {
  return detectProvider(cfg) === "openai-compatible"
    ? `${cfg.baseUrl}/chat/completions`
    : `${cfg.baseUrl}/v1beta/models/${cfg.model}:generateContent`;
}

export function createGenerator(cfg: AiConfig): ReviewGenerator {
  if (!cfg.apiKey) throw new Error("未配置模型 API Key");

  switch (detectProvider(cfg)) {
    case "gemini":
      return new GeminiGenerator(cfg);
    case "openai-compatible":
      return new OpenAiCompatibleGenerator(cfg);
    default:
      throw new Error(`未知的段评生成器：${cfg.provider}`);
  }
}
