/**
 * 二阶段 LLM 重排（rerank）
 * ------------------------------------------------------------
 * 检索链路的第二阶段：在「混合检索(hybrid)」产出的候选池之上，
 * 用 LLM 对 query 与每个候选片段的相关度重新打分，挑出真正最该进
 * 上下文的 TopK。这是 RAG 提升「精准度 / 拒答质量」的关键一步——
 * 向量召回擅长语义泛化但容易把"看着相关其实答非所问"的片段排前面，
 * LLM 重排能基于全局语义做精细判别，把噪声压下去。
 *
 * 设计原则（与项目既有风格一致）：
 *  - 开箱即用 + 优雅降级：LLM 未配置 / 调用失败 / 超时 → 直接沿用
 *    stage-1（hybrid RRF）的顺序，绝不因为重排把链路打断。
 *  - 本地确定性兜底 localRerank：无网络也能跑，便于单测与极端环境。
 *  - 所有分数最终归一到 [0.4, 1]，保持前端「相关度 %」展示一致。
 */
import * as llm from "./llm.js";

/** 重排候选（即混合检索 fusion 后的一个片段） */
export interface RerankCandidate {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  /** stage-1 分数（RRF 融合分）；LLM 重排后会覆盖为 LLM 归一化分 */
  score: number;
  /** 命中来源：vector / keyword / hybrid */
  source?: "vector" | "keyword" | "hybrid";
  /** 命中切片所属章节（可选） */
  chapter?: string;
  /** 命中切片所属文档版本（可选） */
  docVersion?: string;
}

export interface RerankOptions {
  /** 重排后保留条数（默认 = 候选数） */
  topN?: number;
  /** 是否启用 LLM 二阶段重排；false → 退化为原 stage-1 顺序 */
  useLLM?: boolean;
  /** 自定义 LLM 补全函数（测试 / 替换 provider 用） */
  complete?: (params: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
  }) => Promise<string>;
  /** 单次重排调用超时（毫秒） */
  timeoutMs?: number;
}

// ============= 本地确定性重排（无网络兜底） =============

/**
 * 本地重排打分：以 query 与片段的「词汇重合度」为核心信号——
 * 中文按字符 2-gram、英文按词做 Jaccard，叠加子串包含加成。返回 0~1。
 * 注意：它只是 lexical 信号，通常弱于 hybrid(RRF) 已融合的结果，
 * 因此默认不作为 LLM 失败时的主兜底（主兜底保留 stage-1 顺序），
 * 但作为独立可测函数，在「明确想用本地策略」或离线环境时有用。
 */
export function localRerankScore(query: string, content: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(query);
  const c = norm(content);
  if (!q || !c) return 0;

  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    for (const w of s.split(/[^a-z0-9一-鿿]+/i).filter((w) => w.length > 1))
      set.add(w);
    return set;
  };
  const gq = grams(q);
  const gc = grams(c);
  if (gq.size === 0) return 0;
  let inter = 0;
  for (const g of gq) if (gc.has(g)) inter++;
  const jaccard = inter / (gq.size + gc.size - inter || 1);

  // 子串包含加成：query 整串出现在片段里，是强相关信号
  const containment = c.includes(q) ? 0.3 : 0;
  return Math.min(1, jaccard + containment);
}

/** 本地重排：按 localRerankScore 排序取 topN */
export function localRerank(
  query: string,
  candidates: RerankCandidate[],
  topN?: number,
): RerankCandidate[] {
  const scored = candidates.map((cand) => ({
    ...cand,
    score: localRerankScore(query, cand.content),
  }));
  scored.sort((a, b) => b.score - a.score);
  return topN ? scored.slice(0, topN) : scored;
}

// ============= LLM 二阶段重排 =============

/**
 * 从模型可能夹带的文本中稳健抽取 JSON 数组
 * （容忍 ```json 代码块包裹、前后多余说明文字）。
 */
function extractJsonArray(text: string): Array<{ index: number; score: number }> {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const tryParse = (s: string): Array<{ index: number; score: number }> => {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr as Array<{ index: number; score: number }>;
    throw new Error("not array");
  };
  // 1) 直接解析
  try {
    return tryParse(cleaned);
  } catch {
    /* fall through */
  }
  // 2) 截取第一个 [ ... ] 区间
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return tryParse(cleaned.slice(start, end + 1));
  }
  throw new Error("无法从模型输出解析出 JSON 数组");
}

/**
 * 二阶段 LLM 重排：把候选片段打包发给 LLM，要求对每个片段与 query 的
 * 相关度打 0~10 分，返回重排后的 topN。
 *
 * 返回 null 表示模型输出不可用（解析失败/空集），由上层决定兜底策略。
 * 模型若漏评某些片段，缺失片段保留其 stage-1 分数，保证不丢候选。
 */
export async function rerankWithLLM(
  query: string,
  candidates: RerankCandidate[],
  opts: RerankOptions = {},
): Promise<RerankCandidate[] | null> {
  if (candidates.length === 0) return [];
  const topN = opts.topN ?? candidates.length;
  const complete =
    opts.complete ?? ((p) => llm.complete(p));

  const passages = candidates
    .map((c, i) => `[${i}]（来源：${c.docName}）\n${c.content}`)
    .join("\n\n");

  const systemPrompt =
    "你是一个中文 RAG 系统的相关性重排序模型。用户会给你一个查询和若干候选文本片段。" +
    "请独立评估每个片段与查询的相关程度，给出 0~10 的相关性分数（10=完全能回答问题，0=完全无关）。" +
    "只输出一个 JSON 数组，不要任何解释；数组元素格式为 {\"index\": <片段编号>, \"score\": <0-10 的数字>}，" +
    "必须覆盖你看到的每一个片段，且 index 与输入编号一致。";

  const userPrompt = `查询：${query}\n\n候选片段：\n${passages}`;

  const raw = await complete({
    prompt: userPrompt,
    systemPrompt,
    temperature: 0,
  });
  const parsed = extractJsonArray(raw);

  // 把模型分数映射回候选（按 index）；缺失的候选保留 stage-1 分数兜底
  const scoreByIdx = new Map<number, number>();
  for (const item of parsed) {
    if (typeof item.index === "number" && typeof item.score === "number") {
      scoreByIdx.set(item.index, Math.max(0, Math.min(10, item.score)));
    }
  }
  if (scoreByIdx.size === 0) return null;

  const scored = candidates.map((c, i) => ({
    ...c,
    // LLM 分数归一化到 0~1；缺失项沿用 stage-1 分（已是 0~1 区间）
    score: scoreByIdx.has(i) ? scoreByIdx.get(i)! / 10 : c.score,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

// ============= 编排入口（被 kb.search 调用） =============

/**
 * 重排编排：
 *  - useLLM=false → 直接按 stage-1 顺序截断返回（原混合检索行为，零额外开销）。
 *  - useLLM=true  → 调用 rerankWithLLM；任何失败（网络/超时/解析异常）都
 *    优雅降级为 stage-1 顺序，保证检索链路永不断裂。
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
  opts: RerankOptions = {},
): Promise<RerankCandidate[]> {
  const topN = opts.topN ?? candidates.length;
  if (candidates.length === 0) return [];

  // 未启用 LLM：直接保持 stage-1 顺序
  if (opts.useLLM === false) {
    return candidates.slice(0, topN);
  }

  const timeoutMs = opts.timeoutMs ?? 8000;
  try {
    const withTimeout = new Promise<RerankCandidate[] | null>(
      (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("rerank 超时")),
          timeoutMs,
        );
        rerankWithLLM(query, candidates, opts)
          .then((r) => {
            clearTimeout(timer);
            resolve(r);
          })
          .catch((e) => {
            clearTimeout(timer);
            reject(e);
          });
      },
    );
    const result = await withTimeout;
    if (result && result.length > 0) return result;
  } catch (e: any) {
    console.warn(
      `[Rerank] LLM 重排失败，降级为 stage-1 顺序：${e?.message ?? e}`,
    );
  }
  // 兜底：保持 stage-1（hybrid RRF）顺序
  return candidates.slice(0, topN);
}
