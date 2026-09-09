/**
 * 二阶段重排 · Cross-Encoder（为主重排器）
 * ------------------------------------------------------------
 * 设计定位（与项目「模型当第三方既有资产」铁律一致）：
 *   Cross-Encoder 重排模型是一个「团队/开源既有资产」，本项目只做**服务化封装**
 *   —— 通过 HTTP 调用一个可配置的重排端点（如 bge-reranker / 自部署 vLLM 重排服务），
 *   把 (query, passage) 对交给它打 0~1 相关性分，再据此重排。我们**不训练、不微调**。
 *
 * 优雅降级：
 *   - 未配置 CROSS_ENCODER_URL → 直接返回 null，由上层退回到 LLM 重排 / stage-1。
 *   - 调用失败 / 超时 / 返回格式不对 → 返回 null，同样降级，绝不打断检索链路。
 */
import { RerankCandidate } from './rerank.js';

export interface CrossEncoderOptions {
  /** 重排后保留条数 */
  topN?: number;
  /** 单次调用超时（毫秒，默认 8000） */
  timeoutMs?: number;
}

/** 读取可配置的重排端点；未配置返回 null（调用方据此降级） */
export function crossEncoderUrl(): string | null {
  const u = process.env.CROSS_ENCODER_URL;
  if (!u || !u.trim()) return null;
  return u.trim().replace(/\/+$/, '');
}

/**
 * 用 Cross-Encoder 端点对候选片段重排，返回按相关性降序的候选项。
 * 返回 null 表示不可用（未配置 / 失败 / 超时），调用方需自行降级。
 *
 * 约定的 HTTP 契约（与端点实现方对齐即可）：
 *   POST {CROSS_ENCODER_URL}/rerank
 *   body:   { "query": string, "passages": string[] }
 *   resp:   { "scores": number[] }            // 与 passages 等长，每项 0~1
 *           或 [number, ...]                    // 直接返回 scores 数组
 *           或 { "results": [{ "score": number }, ...] }
 */
export async function rerankWithCrossEncoder(
  query: string,
  candidates: RerankCandidate[],
  opts: CrossEncoderOptions = {},
): Promise<RerankCandidate[] | null> {
  const url = crossEncoderUrl();
  if (!url) return null;
  if (candidates.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const resp = await fetch(`${url}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, passages: candidates.map((c) => c.content) }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();

    // 兼容多种返回形态，统一抽成与 candidates 等长的 scores
    let scores: number[] | null = null;
    if (Array.isArray(data)) scores = data as number[];
    else if (Array.isArray(data.scores)) scores = data.scores as number[];
    else if (Array.isArray(data.results)) scores = (data.results as any[]).map((r) => (typeof r === 'number' ? r : Number(r.score)));
    if (!scores || scores.length !== candidates.length) return null;

    const scored = candidates.map((c, i) => ({
      ...c,
      score: Math.max(0, Math.min(1, Number(scores![i]) || 0)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, opts.topN ?? candidates.length);
  } catch {
    // 超时 / 网络错误 / JSON 解析失败 —— 一律降级
    return null;
  } finally {
    clearTimeout(timer);
  }
}
