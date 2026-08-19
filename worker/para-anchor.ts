/**
 * 段落锚点定位。
 *
 * 段号不可靠：生成时按服务端抓到的正文算，App 的分段常与之不同——分页少抓、
 * 换行差异、净化规则删行、网站改标点。所以段评绑定的不是"第几段"，而是
 * "章节里的这段文字"，请求方给出正文时现算段号。
 *
 * 四级降级，逐级放宽：
 *   L1 全文 hash    —— 归一化后完全一致
 *   L2 首尾锚点     —— 段首/段尾 40 字，扛住中间插广告、改标点
 *   L3 前后文三元组 —— before/after 夹逼，扛住 App 把一段拆成两段
 *   L4 模糊相似度   —— n-gram Jaccard + 长度约束，扛住网站改写个别字词
 */

/** 前后文锚点各取多少字 */
const CTX_LEN = 40;
/** 目标段落存多少字（够做 L4 相似度即可） */
export const TARGET_LEN = 160;
/** 首尾锚点长度 */
const EDGE_LEN = 40;
/** 判定为同一段的最低 Jaccard 相似度 */
const FUZZY_MIN = 0.72;
/**
 * 最优与次优的差距下限。
 * 「他点了点头。」这类句子在一章里反复出现，相似度都很高，
 * 认不准到底是哪一句时宁可不显示。
 */
const FUZZY_MARGIN = 0.08;
/** L4 两段长度比值超过此值就认为不是同一段 */
const LEN_RATIO_MAX = 3;
/** 关键片段取几个、每个多长 */
const KEY_COUNT = 5;
const KEY_LEN = 12;
/** 几个片段命中同一段才算定位 */
const KEY_MIN_HITS = 2;
/** 短于此长度的段落不参与 L2/L4——"他点点头。"这种句子重复率太高 */
const MIN_ANCHOR_LEN = 8;

/**
 * 归一化：只保留能稳定跨站的信息。
 * 空白、标点、全半角、大小写全部抹平，网站换个标点不影响定位。
 */
export function normalizeAnchorText(text: string): string {
  return String(text ?? "")
    // 全角 ASCII → 半角
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ")
    // 各类标点、空白一律丢弃
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

export interface ParaAnchor {
  /** 归一化全文（截断到 TARGET_LEN） */
  target: string;
  /** 上一段结尾 CTX_LEN 字 */
  before: string;
  /** 下一段开头 CTX_LEN 字 */
  after: string;
}

/** 为第 index 段（0 基）建锚点，顺带取前后文 */
export function buildAnchor(paragraphs: string[], index: number): ParaAnchor {
  const target = normalizeAnchorText(paragraphs[index] ?? "").slice(0, TARGET_LEN);
  const prev = normalizeAnchorText(paragraphs[index - 1] ?? "");
  const next = normalizeAnchorText(paragraphs[index + 1] ?? "");
  return {
    target,
    before: prev.slice(-CTX_LEN),
    after: next.slice(0, CTX_LEN),
  };
}

/** 把锚点打包成一列存库；老数据只有纯文本，解包时按 target 处理 */
export function packAnchor(a: ParaAnchor): string {
  return JSON.stringify({ t: a.target, b: a.before, a: a.after });
}

export function unpackAnchor(raw: unknown): ParaAnchor | null {
  const s = String(raw ?? "");
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      return { target: String(o.t ?? ""), before: String(o.b ?? ""), after: String(o.a ?? "") };
    } catch {
      /* 落到下面按裸文本处理 */
    }
  }
  // 兼容只存了段落原文的旧记录
  return { target: normalizeAnchorText(s).slice(0, TARGET_LEN), before: "", after: "" };
}

/** 字符二元组集合，用于 Jaccard */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / (a.size + b.size - hit);
}

/** 请求方正文的预处理索引，一次章节只建一遍 */
export interface ParagraphIndex {
  /** 归一化后的各段正文 */
  norms: string[];
  byFull: Map<string, number>;
  byHead: Map<string, number>;
  byTail: Map<string, number>;
  /** 关键片段 → 出现的段落下标（可多段） */
  byKey: Map<string, number[]>;
  grams: Set<string>[];
}

/** 从一段文字里均匀抽几个关键片段，覆盖首、中、尾 */
export function keyFragments(n: string): string[] {
  if (n.length < MIN_ANCHOR_LEN) return [];
  if (n.length <= KEY_LEN) return [n];
  const out: string[] = [];
  const slots = Math.min(KEY_COUNT, Math.max(2, Math.floor(n.length / KEY_LEN)));
  // 首尾各钉一个，中间均分 —— 广告常插在头尾，中间片段最可靠
  for (let i = 0; i < slots; i++) {
    const start = Math.round((i * (n.length - KEY_LEN)) / (slots - 1));
    const frag = n.slice(start, start + KEY_LEN);
    if (frag.length === KEY_LEN && !out.includes(frag)) out.push(frag);
  }
  return out;
}

export function buildIndex(paragraphs: string[]): ParagraphIndex {
  const norms = paragraphs.map((p) => normalizeAnchorText(p));
  const byFull = new Map<string, number>();
  const byHead = new Map<string, number>();
  const byTail = new Map<string, number>();
  const byKey = new Map<string, number[]>();

  for (let i = 0; i < norms.length; i++) {
    const n = norms[i];
    if (!n) continue;
    for (const frag of keyFragments(n)) {
      const list = byKey.get(frag);
      if (list) list.push(i);
      else byKey.set(frag, [i]);
    }
    const full = n.slice(0, TARGET_LEN);
    if (!byFull.has(full)) byFull.set(full, i);
    if (n.length >= MIN_ANCHOR_LEN) {
      const head = n.slice(0, EDGE_LEN);
      const tail = n.slice(-EDGE_LEN);
      if (!byHead.has(head)) byHead.set(head, i);
      if (!byTail.has(tail)) byTail.set(tail, i);
    }
  }

  return { norms, byFull, byHead, byTail, byKey, grams: norms.map(bigrams) };
}

export type MatchLevel = "hash" | "edge" | "key" | "context" | "fuzzy" | null;

export interface MatchResult {
  /** 0 基段落下标，未命中为 -1 */
  index: number;
  level: MatchLevel;
}

/**
 * 在请求方正文里定位一条锚点。
 * 逐级降级，命中即返回；全部失败返回 index = -1。
 */
export function locate(
  idx: ParagraphIndex,
  anchor: ParaAnchor,
  /** 已被更高级别占住的段落，模糊级不再抢 */
  taken?: ReadonlySet<number>
): MatchResult {
  const { target, before, after } = anchor;
  if (!target) return { index: -1, level: null };

  // L1 全文一致
  const exact = idx.byFull.get(target);
  if (exact !== undefined) return { index: exact, level: "hash" };

  // L2 首尾锚点：段首或段尾 40 字命中即可
  if (target.length >= MIN_ANCHOR_LEN) {
    const head = idx.byHead.get(target.slice(0, EDGE_LEN));
    if (head !== undefined) return { index: head, level: "edge" };
    const tail = idx.byTail.get(target.slice(-EDGE_LEN));
    if (tail !== undefined) return { index: tail, level: "edge" };

    // 目标是请求方某段的子串（App 把两段合并了），或反过来（App 拆了段）
    for (let i = 0; i < idx.norms.length; i++) {
      const n = idx.norms[i];
      if (n.length < MIN_ANCHOR_LEN) continue;
      if (n.includes(target) || (target.length >= n.length && target.includes(n))) {
        return { index: i, level: "edge" };
      }
    }
  }

  // L3 关键片段：跨首/中/尾取几个短串，多数落在同一段就算定位。
  // 首尾都被改动、但正文主体还在时，就靠这一级。
  {
    const frags = keyFragments(target);
    if (frags.length >= KEY_MIN_HITS) {
      const votes = new Map<number, number>();
      for (const frag of frags) {
        for (const at of idx.byKey.get(frag) ?? []) {
          votes.set(at, (votes.get(at) ?? 0) + 1);
        }
      }
      let best = -1;
      let bestHits = 0;
      let tied = false;
      for (const [at, hits] of votes) {
        if (hits > bestHits) {
          bestHits = hits;
          best = at;
          tied = false;
        } else if (hits === bestHits) {
          tied = true;
        }
      }
      // 平票说明几段长得一样，宁可不猜
      if (best >= 0 && bestHits >= KEY_MIN_HITS && !tied) {
        return { index: best, level: "key" };
      }
    }
  }

  // L4 前后文夹逼：目标段自身面目全非，但前后邻居还认得出
  if (before || after) {
    const beforeAt = before ? findEdge(idx, before, "tail") : -1;
    const afterAt = after ? findEdge(idx, after, "head") : -1;

    if (beforeAt >= 0 && afterAt > beforeAt + 1) {
      // 夹在中间，取紧邻 before 的那段
      return { index: beforeAt + 1, level: "context" };
    }
    if (beforeAt >= 0 && afterAt === -1 && beforeAt + 1 < idx.norms.length) {
      return { index: beforeAt + 1, level: "context" };
    }
    if (afterAt > 0 && beforeAt === -1) {
      return { index: afterAt - 1, level: "context" };
    }
  }

  // L5 模糊：n-gram 相似度取最高，需过阈值且长度不能差太多
  if (target.length >= MIN_ANCHOR_LEN) {
    const tg = bigrams(target);
    let best = -1;
    let bestScore = 0;
    let runnerUp = 0;
    for (let i = 0; i < idx.norms.length; i++) {
      const n = idx.norms[i];
      if (n.length < MIN_ANCHOR_LEN) continue;
      // 别人已精确命中的段落不抢：一段只认一个主
      if (taken?.has(i)) continue;
      const ratio = n.length > target.length ? n.length / target.length : target.length / n.length;
      if (ratio > LEN_RATIO_MAX) continue;
      const score = jaccard(tg, idx.grams[i]);
      if (score > bestScore) {
        runnerUp = bestScore;
        bestScore = score;
        best = i;
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }
    // 两个候选分数掘得太近就是认不准，钉错段落比不显示更糟
    if (best >= 0 && bestScore >= FUZZY_MIN && bestScore - runnerUp >= FUZZY_MARGIN) {
      return { index: best, level: "fuzzy" };
    }
  }

  return { index: -1, level: null };
}

/** 在正文里找一段上下文锚点：先精确后包含 */
function findEdge(idx: ParagraphIndex, edge: string, side: "head" | "tail"): number {
  if (edge.length < MIN_ANCHOR_LEN) return -1;
  const map = side === "head" ? idx.byHead : idx.byTail;
  const hit = map.get(edge.slice(0, EDGE_LEN));
  if (hit !== undefined) return hit;

  for (let i = 0; i < idx.norms.length; i++) {
    const n = idx.norms[i];
    if (n.length < MIN_ANCHOR_LEN) continue;
    if (side === "tail" ? n.endsWith(edge) : n.startsWith(edge)) return i;
    if (n.includes(edge)) return i;
  }
  return -1;
}
