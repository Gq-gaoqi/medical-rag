/**
 * 医疗导诊领域层（server/triage.ts）
 * ------------------------------------------------------------
 * 在线链路「生成」阶段：把检索到的知识库片段 + 用户主诉，交给医疗大模型
 * 生成**结构化分诊结论**（推荐科室 / 分诊级别 / 紧急度 / 就诊建议 / 注意事项）。
 *
 * 模型定位（AI 应用岗铁律）：医疗大模型是团队/开源既有资产，本项目只做
 * 「服务化调用 + 提示词编排 + JSON 解析 + 降级」，不训练、不微调。
 * 默认复用 .env 里的 qwen 模型（可改配置切换医疗模型），生成后用 JSON 模式约束输出。
 */
import { search, type SearchResult } from './kb.js';
import * as llm from './llm.js';

export type Urgency = 'high' | 'medium' | 'low';
export type Confidence = 'high' | 'low';

/** 结构化分诊结论（前端渲染为「分诊卡片」） */
export interface TriageResult {
  /** 推荐就诊科室 */
  department: string;
  /** 分诊级别：急诊 / 亚急 / 平诊 */
  triageLevel: string;
  /** 紧急度 */
  urgency: Urgency;
  /** 就诊建议（简洁） */
  advice: string;
  /** 注意事项（可含分点） */
  notes: string;
  /** 免责声明 */
  disclaimer: string;
  /** 置信度：知识库高命中=high，低置信(阈值降级)=low */
  confidence: Confidence;
}

/** 医疗导诊系统提示词：强约束只输出 JSON，字段固定便于前端结构化渲染 */
export const DEFAULT_TRIAGE_PROMPT = `你是 RAG 智能医疗导诊系统。请严格基于下面【知识库参考内容】为用户做分诊建议。
要求：
1. 只使用参考内容中的信息；参考内容不足时，可结合通用医学常识，但必须在「注意事项」中注明"以下为通用建议，仅供参考"。
2. 必须只输出一个 JSON 对象，不要 markdown 代码块、不要任何额外解释，字段如下：
{
  "department": "推荐就诊科室（如：神经内科 / 急诊科 / 产科）",
  "triageLevel": "急诊 / 亚急 / 平诊",
  "urgency": "high 或 medium 或 low",
  "advice": "简洁的就诊建议",
  "notes": "注意事项，可分点陈述",
  "disclaimer": "本结果由 AI 生成，不能替代医生诊断；紧急情况请立即拨打 120 或前往急诊"
}

【知识库参考内容】
{context}`;

/** 构建导诊系统提示词（支持 {context} 占位符） */
export function buildTriageSystemPrompt(results: SearchResult[], customPrompt?: string): string {
  const template = customPrompt && customPrompt.trim() ? customPrompt : DEFAULT_TRIAGE_PROMPT;
  const context =
    results.length > 0
      ? results
          .map((r, i) => {
            const chapterTag = r.chapter ? `（章节：${r.chapter}）` : '';
            return `[片段 ${i + 1}]（来源：${r.docName}${chapterTag}，相关度：${(r.score * 100).toFixed(1)}%）\n${r.content}`;
          })
          .join('\n\n---\n\n')
      : '（未检索到相关内容，请依据通用医学常识给出分诊建议，并明确说明仅供参考）';
  if (template.includes('{context}')) return template.replace('{context}', context);
  return `${template}\n\n【知识库参考内容】\n${context}`;
}

/** 从模型可能夹带的文本里稳健抽取 JSON 对象 */
function extractJsonObject(text: string): any {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(cleaned.slice(s, e + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface TriageResponse {
  /** 结构化分诊结论（解析失败为 null） */
  triage: TriageResult | null;
  /** 检索来源（带章节/版本，供前端展示依据） */
  sources: SearchResult[];
  /** 模型原始输出（调试 / 可解释性） */
  raw: string;
  /** 未配置/失败等说明 */
  modelNote?: string;
}

/**
 * 执行一次导诊：检索 → 组装导诊提示词 → 调用大模型 → 解析为结构化分诊结论。
 * 任何失败都优雅降级（triage=null + 说明），绝不抛出中断前端。
 */
export async function triage(query: string): Promise<TriageResponse> {
  const results = await search(query, 5);
  const lowConfidence = results[0]?.lowConfidence ?? false;

  if (!llm.isLlmConfigured()) {
    return { triage: null, sources: results, raw: '', modelNote: 'LLM 未配置，无法生成分诊结论（请配置 OPENAI_API_KEY 或 CodeBuddy 凭据）' };
  }

  const systemPrompt = buildTriageSystemPrompt(results);
  let raw = '';
  try {
    raw = await llm.complete({ prompt: query, systemPrompt, temperature: 0 });
  } catch (e: any) {
    return { triage: null, sources: results, raw: String(e?.message ?? e), modelNote: 'LLM 调用失败' };
  }

  const parsed = extractJsonObject(raw);
  if (!parsed) return { triage: null, sources: results, raw };

  const urgency: Urgency = (['high', 'medium', 'low'].includes(parsed.urgency) ? parsed.urgency : 'medium') as Urgency;
  const triage: TriageResult = {
    department: String(parsed.department ?? '建议线下就诊咨询'),
    triageLevel: String(parsed.triageLevel ?? '—'),
    urgency,
    advice: String(parsed.advice ?? ''),
    notes: String(parsed.notes ?? ''),
    disclaimer: String(
      parsed.disclaimer ?? '本结果由 AI 生成，不能替代医生诊断；紧急情况请立即拨打 120 或前往急诊。',
    ),
    confidence: lowConfidence ? 'low' : 'high',
  };

  // 低置信兜底：知识库匹配度低时，明确建议线下就诊，避免 AI 瞎答
  if (lowConfidence) {
    triage.notes = (triage.notes ? `${triage.notes}\n` : '') +
      '【提示】知识库匹配度较低，建议优先线下就诊或挂全科 / 急诊进一步评估。';
  }

  return { triage, sources: results, raw };
}
