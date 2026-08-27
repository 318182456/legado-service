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
  taken?: ReadonlySet<number>,
  /** 评论正文；锚点跨多段时用它判断评的到底是哪一段 */
  commentText?: string
): MatchResult {
  const { target, before, after } = anchor;
  if (!target) return { index: -1, level: null };

  // L1 全文一致。
  //
  // byFull 的键是段落前 TARGET_LEN 字，target 存库时也截断到同样长度，
  // 所以命中段落比 target 长时这只是「前 160 字相同」，不是全文相等 ——
  // 长段被 App 拆开时，前半段必然满足这个条件，评论会被钉在前半段上。
  // 这种情况留给下面的跨段判定，别在这里抢先返回。
  const exact = idx.byFull.get(target);
  if (exact !== undefined && idx.norms[exact].length <= target.length) {
    return { index: exact, level: "hash" };
  }

  // L2a 锚点被拆成了连续多段。
  //
  // 生成时服务端把「长发公主…一坐」+「那去森林里摘蘑菇…」当成一段，
  // 现在 reader 把它们分开了。此时不能简单选段首所在的那段 ——
  // 评论讲的是蘑菇，却会挂到「公主换衣服」那句上。
  // 按字数取锚点主体落在哪一段，平分时归前一段。
  if (target.length >= MIN_ANCHOR_LEN) {
    const spanned = locateSpan(idx, target, commentText);
    if (spanned >= 0) return { index: spanned, level: "edge" };
  }

  // L2b 首尾锚点：段首或段尾 40 字命中即可
  if (target.length >= MIN_ANCHOR_LEN) {
    const head = idx.byHead.get(target.slice(0, EDGE_LEN));
    if (head !== undefined) {
      // 段首对上但该段比锚点长：原段很可能延续到后面，让评论来选
      const refined = refineTruncatedHit(idx, head, target, commentText);
      return { index: refined >= 0 ? refined : head, level: "edge" };
    }
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

/**
 * 锚点被拆成了连续多段时，按主体字数定位。
 *
 * 从每一段试着往后拼，拼出的串能覆盖整个 target 就算命中。
 * 命中后在这几段里选占字数最多的一段 —— 评论通常冲着篇幅最长
 * 的那部分而来。只拼到 SPAN_MAX 段，再多就不是拆段而是误匹配了。
 */
const SPAN_MAX = 4;
/** 首段对齐时比多少字（不要求全串相等，两边标点可能不同） */
const SPAN_HEAD = 16;
/** 拼接串与 target 的最低重合比例 */
const SPAN_COVER = 0.85;
/** 评论与各段相关度的最小区分度，拉不开就不猜 */
const SPAN_MARGIN = 0.01;

/**
 * target 截断导致锚点只覆盖到长段的前半部分时，在「命中段 + 其后续段」
 * 里靠评论内容重选。
 *
 * 服务端一个 300 字长段，锚点只存了前 160 字；App 把它拆成 180+120 两段。
 * 锚点与前半段的前 160 字完全相同，任何基于 target 的比对都只会指向前半段，
 * 而评论可能讲的是后半段。此时 target 里没有任何后半段的信息，只能看评论
 * 与哪一段用词更近。区分度拉不开就返回 -1，维持原判 —— 宁可不动也不瞎挪。
 */
function refineTruncatedHit(
  idx: ParagraphIndex,
  hit: number,
  target: string,
  commentText?: string
): number {
  // 命中段没超过 target 长度，锚点是完整覆盖的，不存在这个问题
  if (idx.norms[hit].length <= target.length) return -1;
  if (!commentText) return -1;

  const cg = bigrams(normalizeAnchorText(commentText));
  if (!cg.size) return -1;

  // 候选：命中段本身，加上紧随其后、可能属于同一原始段落的几段
  const parts = [hit];
  for (let j = hit + 1; j < idx.norms.length && parts.length < SPAN_MAX; j++) {
    if (idx.norms[j].length < MIN_ANCHOR_LEN) break;
    // 后续段落若能被 target 覆盖到，说明拆段边界还在 target 之内，
    // locateSpan 已经处理过，这里只管 target 覆盖不到的部分
    parts.push(j);
  }
  if (parts.length < 2) return -1;

  let best = -1;
  let bestScore = 0;
  let runnerUp = 0;
  for (const at of parts) {
    const score = jaccard(cg, idx.grams[at]);
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = at;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (best >= 0 && bestScore > 0 && bestScore - runnerUp >= SPAN_MARGIN) return best;
  return -1;
}

function locateSpan(idx: ParagraphIndex, target: string, commentText?: string): number {
  const cg = commentText ? bigrams(normalizeAnchorText(commentText)) : null;

  for (let i = 0; i < idx.norms.length; i++) {
    const first = idx.norms[i];
    if (first.length < MIN_ANCHOR_LEN) continue;

    // 首段要与 target 开头对得上。不用严格前缀 —— 两边的引号形态、
    // 标点可能不同（「」 vs “”），归一化过的串也未必完全相等。
    // 取前 SPAN_HEAD 字比，够分辨是哪一段就行。
    const headLen = Math.min(SPAN_HEAD, first.length, target.length);
    if (headLen < MIN_ANCHOR_LEN) continue;
    if (first.slice(0, headLen) !== target.slice(0, headLen)) continue;

    // 整段相等交给 L1，这里只管真拆开的
    if (first === target) continue;

    // target 截断到 TARGET_LEN 时，first 反而可能更长：一个 300 字的
    // 长段被 App 拆成 180+120，前半段就比 160 字的 target 长。这仍然是
    // 拆段，只是 target 不足以覆盖到第二段 —— 此时无从判断评论归属，
    // 交给后面的级别处理，别在这里按「首段占字最多」草率选中前半段。
    if (first.length >= target.length) continue;

    let joined = first;
    const parts = [i];
    for (let j = i + 1; j < idx.norms.length && parts.length < SPAN_MAX; j++) {
      joined += idx.norms[j];
      parts.push(j);
      if (joined.length >= target.length) break;
    }
    if (parts.length < 2) continue;

    // 拼出来的串要能覆盖 target。同样不要求严格前缀：
    // 按字符算重合度，达到 SPAN_COVER 就算同一段落被拆开。
    const cover = prefixOverlap(joined, target);
    if (cover < target.length * SPAN_COVER) continue;

    // 归属到哪一段：先看评论说的是什么。
    //
    // 「吃下去能看到小人儿的蘑菇」这条评论，锚点跨了「公主坐下」与
    // 「推荐蘑菇」两段，前一段还更长 —— 按字数会选错。看评论与哪段
    // 用词重合度高，才能选中讲蘑菇的那一段。
    if (cg && cg.size) {
      let best = -1;
      let bestScore = 0;
      let runnerUp = 0;
      for (const at of parts) {
        const score = jaccard(cg, idx.grams[at]);
        if (score > bestScore) {
          runnerUp = bestScore;
          bestScore = score;
          best = at;
        } else if (score > runnerUp) {
          runnerUp = score;
        }
      }
      // 评论对几段的相关度差不多时不强分，转而按字数
      if (best >= 0 && bestScore > 0 && bestScore - runnerUp >= SPAN_MARGIN) return best;
    }

    // 评论看不出倾向（或没传）时，按在 target 里占字最多的一段
    let best = parts[0];
    let bestLen = 0;
    let used = 0;
    for (const at of parts) {
      const seg = idx.norms[at];
      const within = Math.min(seg.length, Math.max(0, target.length - used));
      // 严格大于：平分时保留靠前的一段
      if (within > bestLen) {
        bestLen = within;
        best = at;
      }
      used += seg.length;
    }
    return best;
  }

  // 反方向：请求方把好几段合成了一段，而锚点只对应其中一段。
  // 锚点存库时截断到 TARGET_LEN，所以这里拿 target 去合并段里找。
  //
  // 注意「n 比 target 长且包含 target」这个判据，在拆段时同样成立：
  // 一个 300 字长段的锚点只存了前 160 字，App 把它拆成 175+125，
  // 前半段就完全包含 target。两种相反的情形共享同一判据，光看长度
  // 分不出来 —— 所以命中后再让评论内容裁一次，它更像后续段落就挪过去。
  for (let i = 0; i < idx.norms.length; i++) {
    const n = idx.norms[i];
    if (n.length <= target.length || n.length < MIN_ANCHOR_LEN) continue;
    if (n.includes(target)) {
      const refined = refineTruncatedHit(idx, i, target, commentText);
      return refined >= 0 ? refined : i;
    }
  }
  return -1;
}

/** 两串从头开始逐字相同的长度 */
function prefixOverlap(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
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
