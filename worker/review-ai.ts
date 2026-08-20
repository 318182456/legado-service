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
  /** 热点段落数：评论向这几段集中，其余段落留白 */
  hotspots: number;
  /** 回复链最大层数，1 表示只允许单层回复 */
  replyDepth: number;
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
  hotspots: number;
  replyDepth: number;
  /** 单段落最长送入模型的字数，超出则截断 */
  maxParaChars: number;
}

// ─── 配置 ─────────────────────────────────────────────────────────

/**
 * 人设只描述行为，刻意不给「毒舌吐槽役」这类标签名：
 * 带冒号的标签模型会顺手抄进 author，评论区就成了一排
 * 「设定控」「蘑菇爱好者」，比内容本身更容易暴露是机器写的。
 */
export const DEFAULT_PERSONAS = [
  "一句话戳破套路，语气欠但不刻薄",
  "顺着伏笔猜后续，爱说“我赌五毛”",
  "抠设定和前文细节，偶尔纠正作者",
  "只会“啊啊啊”“破防了”“这段封神”这类短句",
  "拿作者别的书或同类桥段作比较",
  "盯住一个不起眼的道具或动作反复琢磨",
  "只关心角色好不好看、谁和谁般配",
  "催更、嫌铺垫长、“说重点”",
  "代入角色处境，为角色难过或高兴",
  "接梗玩梗，爱用网络流行语",
  "专挑逻辑漏洞抬杠，但不骂人",
  "给角色起外号，并坚持使用",
  "像做阅读理解一样拆解人物动机",
  "单纯来看热闹，一两个字的短评",
  "把小说当知识点，“这段可以当作文素材”",
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

  const density = Number(cfg["review_density"] || "12");
  const hotspots = Number(cfg["review_hotspots"] || "3");
  const replyDepth = Number(cfg["review_reply_depth"] || "3");

  return {
    // auto 时按 base URL 形态自动判断，见 detectProvider
    provider: cfg["review_ai_provider"] || "auto",
    apiKey: cfg["gemini_api_key"] || "",
    model: cfg["gemini_model"] || DEFAULT_MODEL,
    baseUrl: (cfg["gemini_base_url"] || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    personas,
    density: Number.isFinite(density) ? Math.min(40, Math.max(1, density)) : 12,
    hotspots: Number.isFinite(hotspots) ? Math.min(10, Math.max(1, hotspots)) : 3,
    replyDepth: Number.isFinite(replyDepth) ? Math.min(5, Math.max(1, replyDepth)) : 3,
    maxParaChars: 400,
  };
}

// ─── Prompt ───────────────────────────────────────────────────────

/**
 * 真实段评区是幂律分布：名场面几十条、平淡段落一条没有。
 * 均匀撒点会一眼看出是机器生成，所以显式要求向热点段落集中。
 */
function buildPrompt(input: GenerateInput, maxParaChars: number): string {
  const numbered = input.paragraphs
    .map((p, i) => {
      const text = p.length > maxParaChars ? p.slice(0, maxParaChars) + "…" : p;
      return `[${i + 1}] ${text}`;
    })
    .join("\n");

  const chainRule =
    input.replyDepth <= 1
      ? "热点段落里挑 1 到 2 条，各带 1 条回复。"
      : `热点段落至少要有 1 条形成${input.replyDepth}层左右的对话链：` +
        `有人接话、有人抬杠、原评论者再回一句。回复用 replies 逐层嵌套，最深 ${input.replyDepth} 层。`;

  return `你在为一款小说阅读器生成"段评"——读者读到某一段时顺手发的即时评论。

书名：《${input.bookName}》${input.author ? `　作者：${input.author}` : ""}
章节：${input.chapterTitle}

正文段落（方括号内是段落序号）：
${numbered}

本章总共写 ${input.density} 条主评论，但**绝对不要均匀分布**，要像真实评论区那样扎堆：

1. 先从全章挑出 ${input.hotspots} 个最有反应点的"热点段落"——反转、名场面、角色高光、
   炸裂台词或明显槽点。这几段每段给 3 到 6 条评论，不同人设从不同角度七嘴八舌。
2. 剩下的评论零散分给另外几段，每段只给 1 条。
3. **绝大多数段落不要有任何评论**。平淡的过渡段、环境描写、承接段一律跳过。
4. ${chainRule}
5. 每条评论 8 到 45 字，口语化，像手机上随手打的。不要书面语，
   不要"这段描写生动地体现了"这种腔调。允许错别字式的口语（"卧槽""笑死""好家伙"）。
   约三分之一的评论带一点表情，别条条都带、也别集中在同一段：
   - emoji 放句尾，一条最多两个：😂 🤣 😭 👍 🐶 🔥 💀 🥲 😅 🙏 ❤️
   - 或者颜文字：(╯‵□′)╯ 、(っ °Д °;)っ 、_(:з)∠)_ 、¯\_(ツ)_/¯ 、qwq 、orz
   - 也可以用纯文本的情绪符号："。。。""？？？""哈哈哈哈哈"
   剩下三分之二保持素文字。真人评论区就是这个比例，人人带 emoji 反而假。
6. 评论必须针对那一段的具体内容，不能是放之四海皆准的空话。
   同一段的多条评论要角度各异，不能互相重复。
7. 按下列人设分配评论者。**人设只是行为指导，绝对不能拿来当名字**：
${input.personas.map((p) => `   - ${p}`).join("\n")}
8. author 要像真实书评区里随手注册的用户名，不是人设标签、不是角色定位描述。参考真人取名习惯：
   - 日常口语或碎片心情："今天也不想上班""再睡五分钟""可乐加冰"
   - 名字加数字或字母后缀："阿哲""小林同学""zzz_0721""Lynn"
   - 无意义昵称、叠字、食物、动物："鱼丸""咚咚""橘子汽水""秃头小宝"
   - 半句吐槽或引用："看不懂但大受震撼""我裂开了"
   反面例子（一律不许出现）："设定控""逻辑鬼才""吃瓜路人""熬夜修仙党""考试型"
   "理性分析""老书虫""人间清醒""细节控""梗王""杠精" —— 这些是人设名，写进 author 一眼就假。
   同理禁用「XX爱好者」「XX党」「XX控」「XX狂」「XX粉」「资深XX」这类由兴趣或立场拼出来的名字，
   比如"蘑菇爱好者""考据党""细节控"，真人不会这样给自己起名。
9. 同一章里别出现两个风格雷同的名字，也别整章都用同一种构词法。
10. paraIndex 必须是上面出现过的段落序号。评论章节标题用 -1。
11. 全部使用简体中文。不要使用 Markdown，不要加引号包裹整条评论。`;
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

    // 模型会把对话链嵌套成多层，而库里回复是平铺的（reply_to 指向主评论）。
    // 按深度优先压平，保持对话顺序，读起来仍是一条完整的接话链。
    const replies = flattenReplies(r.replies);

    out.push({ paraIndex, author, content: content.slice(0, 300), replies });
  }

  return out;
}

/** 深度优先压平嵌套回复，保留对话先后顺序 */
function flattenReplies(raw: unknown, depth = 0): { author: string; content: string }[] {
  if (!Array.isArray(raw) || depth > 5) return [];
  const out: { author: string; content: string }[] = [];

  for (const rep of raw) {
    if (!rep || typeof rep !== "object") continue;
    const r = rep as Record<string, unknown>;
    const content = String(r.content ?? "").trim();
    if (!content) continue;

    out.push({
      author: String(r.author ?? "").trim().slice(0, 24) || "书友",
      content: content.slice(0, 200),
    });
    out.push(...flattenReplies(r.replies, depth + 1));
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
