/**
 * 查询理解（Query Understanding，NER + 查询扩展）
 * ------------------------------------------------------------
 * 在线链路步骤2 的第一步：用户一句主诉（往往口语化、信息不全），
 * 先用 LLM 做医疗实体抽取（症状 / 部位 / 病程），再做「查询扩展」，
 * 把扩展后的查询用于后续向量 + 关键词召回，从而显著提升医疗长尾词的命中。
 *
 * 定位（契合校招 AI 应用岗）：这是「用 LLM 做接口编排」的工程能力，
 * 模型是团队/开源既有资产，本项目只做**服务化调用 + 结果解析 + 降级**，
 * 不训练、不微调任何医疗模型。
 *
 * 优雅降级：未启用（QUERY_UNDERSTANDING_ENABLED!=1）或 LLM 未配置/调用失败 →
 * 返回 null，检索层透明回退为「直接用原始 query 检索」，链路不断。
 */
import * as llm from './llm.js';

export interface MedicalEntities {
  /** 症状 / 主诉，如 ["头痛", "恶心呕吐"] */
  symptoms: string[];
  /** 部位，如 ["头部", "胸部"] */
  bodyParts: string[];
  /** 病程 / 急性发作程度，如 "突发""反复发作""持续两小时" */
  course: string;
}

export interface QueryUnderstanding {
  entities: MedicalEntities;
  /** 扩展后的查询（原始 query + 抽取实体拼接），用于下游召回 */
  expandedQuery: string;
}

/** 是否启用查询理解（默认关闭；开启需 LLM 已配置） */
export function queryUnderstandingEnabled(): boolean {
  return process.env.QUERY_UNDERSTANDING_ENABLED === '1' && llm.isLlmConfigured();
}

const SYSTEM_PROMPT = `你是 RAG 智能医疗导诊系统的「查询理解」模块。
用户会给你一句口语化的就诊主诉，请抽取其中的医疗实体，并做查询扩展。

请严格只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块）：
{
  "symptoms": ["症状1", "症状2"],     // 患者描述的不适/症状/体征
  "bodyParts": ["部位1"],             // 涉及的解剖部位
  "course": "病程描述"                // 急性发作/持续时间/严重程度等
}

抽取要求：
- 只抽取文本中确实提到的内容，不要臆测。
- 医学同义词归一（如"胸口""胸部"→"胸部"）。
- course 用简短中文概括病程（如"突发""反复发作""持续两小时"）。`;

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

/**
 * 对查询做医疗实体理解 + 扩展。失败/未启用返回 null（调用方降级）。
 */
export async function understandQuery(query: string): Promise<QueryUnderstanding | null> {
  if (!queryUnderstandingEnabled()) return null;
  try {
    const raw = await llm.complete({ prompt: query, systemPrompt: SYSTEM_PROMPT, temperature: 0 });
    const parsed = extractJsonObject(raw);
    if (!parsed) return null;
    const symptoms: string[] = Array.isArray(parsed.symptoms) ? parsed.symptoms.map(String) : [];
    const bodyParts: string[] = Array.isArray(parsed.bodyParts) ? parsed.bodyParts.map(String) : [];
    const course: string = typeof parsed.course === 'string' ? parsed.course : '';
    // 扩展查询 = 原句 + 症状 + 部位 + 病程，下游召回同时覆盖口语与标准医学词
    const expandedParts = [query, ...symptoms, ...bodyParts, course].filter(Boolean);
    const expandedQuery = Array.from(new Set(expandedParts)).join(' ');
    return {
      entities: { symptoms, bodyParts, course },
      expandedQuery,
    };
  } catch {
    return null;
  }
}
