/**
 * 知识库模块：文档管理、切片、向量化 Embedding、相似度检索
 */
import db from './db.js';
import { v4 as uuidv4 } from 'uuid';
import { getVectorStore, reciprocalRankFusion, type SearchHit } from './vectorStore.js';
import * as llm from './llm.js';
import { rerank, type RerankCandidate } from './rerank.js';
import { rerankWithCrossEncoder, crossEncoderUrl } from './crossEncoder.js';
import { bm25Index } from './bm25.js';
import { understandQuery, queryUnderstandingEnabled } from './queryUnderstanding.js';
import { getCache, setCache, cacheKey } from './cache.js';

// ============= 表结构初始化 =============

db.exec(`
  -- 知识库文档表
  CREATE TABLE IF NOT EXISTS kb_documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded | embedding | ready | error
    chunk_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    embedded_at TEXT,
    doc_version TEXT NOT NULL DEFAULT '1'       -- 文档版本：同一文档多次更新时用于区分
  );

  -- 文档切片 + 向量表
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT,                            -- JSON 数组
    chapter TEXT NOT NULL DEFAULT '',          -- 切片所属章节标题
    doc_version TEXT NOT NULL DEFAULT '1',     -- 所属文档版本
    FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc_id ON kb_chunks(doc_id);

  -- 知识库设置表（key-value）
  CREATE TABLE IF NOT EXISTS kb_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// 迁移：为已有库补充章节 / 版本元数据列（幂等，兼容旧库）
try {
  const chunkCols = db.prepare('PRAGMA table_info(kb_chunks)').all() as Array<{ name: string }>;
  if (!chunkCols.some((c) => c.name === 'chapter')) {
    db.exec("ALTER TABLE kb_chunks ADD COLUMN chapter TEXT NOT NULL DEFAULT ''");
  }
  if (!chunkCols.some((c) => c.name === 'doc_version')) {
    db.exec("ALTER TABLE kb_chunks ADD COLUMN doc_version TEXT NOT NULL DEFAULT '1'");
  }
  const docCols = db.prepare('PRAGMA table_info(kb_documents)').all() as Array<{ name: string }>;
  if (!docCols.some((c) => c.name === 'doc_version')) {
    db.exec("ALTER TABLE kb_documents ADD COLUMN doc_version TEXT NOT NULL DEFAULT '1'");
  }
} catch {
  /* 忽略（列可能已存在） */
}

// ============= 类型定义 =============

export interface KbDocument {
  id: string;
  name: string;
  ext: string;
  size: number;
  content: string;
  status: 'uploaded' | 'embedding' | 'ready' | 'error';
  chunk_count: number;
  error: string | null;
  created_at: string;
  embedded_at: string | null;
  doc_version: string;
}

export interface KbChunk {
  id: string;
  doc_id: string;
  chunk_index: number;
  content: string;
  embedding: string | null;
}

export interface SearchResult {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  score: number;
  /** 命中来源：向量召回 / 关键词召回 / 混合融合 */
  source?: 'vector' | 'keyword' | 'hybrid';
  /** 命中切片所属章节（可选） */
  chapter?: string;
  /** 命中切片所属文档版本（可选） */
  docVersion?: string;
  /** 是否低置信：Top-1 归一化分数低于置信度阈值，建议引导线下就诊（导诊兜底） */
  lowConfidence?: boolean;
}

export interface KbSettings {
  embeddingApiUrl: string;   // OpenAI 兼容的 embeddings 接口地址
  embeddingApiKey: string;
  embeddingModel: string;
  ragPrompt: string;         // 用户自定义 RAG 系统提示词，支持 {context} 占位符
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
}

// 默认 RAG 提示词 —— 用户可在前端「知识库」页面完全自定义
export const DEFAULT_RAG_PROMPT = `你是我的个人知识库助手。请严格基于下面提供的【知识库参考内容】回答用户的问题。

要求：
1. 只使用参考内容中的信息回答，不要编造。
2. 如果参考内容中没有相关信息，请明确告知"知识库中没有找到相关内容"，再给出你自己的一般性建议。
3. 回答时可注明信息来自哪个文档。

【知识库参考内容】
{context}`;

const DEFAULT_SETTINGS: KbSettings = {
  embeddingApiUrl: '',
  embeddingApiKey: '',
  embeddingModel: 'text-embedding-3-small',
  ragPrompt: DEFAULT_RAG_PROMPT,
  topK: 4,
  chunkSize: 800,
  chunkOverlap: 100,
};

// ============= 设置操作 =============

export function getSettings(): KbSettings {
  const rows = db.prepare('SELECT key, value FROM kb_settings').all() as Array<{ key: string; value: string }>;
  const map: Record<string, string> = {};
  rows.forEach(r => { map[r.key] = r.value; });
  const embeddingApiUrl = map.embeddingApiUrl ?? process.env.EMBEDDING_API_URL ?? DEFAULT_SETTINGS.embeddingApiUrl;
  let embeddingModel = map.embeddingModel ?? process.env.EMBEDDING_MODEL ?? DEFAULT_SETTINGS.embeddingModel;
  // 防复发：dashscope 没有 OpenAI 专属模型名 text-embedding-3-small（会 404），
  // 自动纠正为 dashscope 支持的 text-embedding-v3，避免历史问题重现。
  if (/dashscope/i.test(embeddingApiUrl) && embeddingModel === 'text-embedding-3-small') {
    embeddingModel = 'text-embedding-v3';
  }
  return {
    embeddingApiUrl,
    embeddingApiKey: map.embeddingApiKey ?? process.env.EMBEDDING_API_KEY ?? DEFAULT_SETTINGS.embeddingApiKey,
    embeddingModel,
    ragPrompt: map.ragPrompt ?? DEFAULT_SETTINGS.ragPrompt,
    topK: map.topK ? parseInt(map.topK, 10) : DEFAULT_SETTINGS.topK,
    chunkSize: map.chunkSize ? parseInt(map.chunkSize, 10) : DEFAULT_SETTINGS.chunkSize,
    chunkOverlap: map.chunkOverlap ? parseInt(map.chunkOverlap, 10) : DEFAULT_SETTINGS.chunkOverlap,
  };
}

export function saveSettings(updates: Partial<KbSettings>): KbSettings {
  const stmt = db.prepare('INSERT INTO kb_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null) {
      stmt.run(key, String(value));
    }
  }
  return getSettings();
}

// ============= 文档操作 =============

export function createDocument(doc: { name: string; ext: string; size: number; content: string }): KbDocument {
  const record: KbDocument = {
    id: uuidv4(),
    name: doc.name,
    ext: doc.ext,
    size: doc.size,
    content: doc.content,
    status: 'uploaded',
    chunk_count: 0,
    error: null,
    created_at: new Date().toISOString(),
    embedded_at: null,
    doc_version: '1',
  };
  db.prepare(`
    INSERT INTO kb_documents (id, name, ext, size, content, status, chunk_count, error, created_at, embedded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(record.id, record.name, record.ext, record.size, record.content, record.status, record.chunk_count, record.error, record.created_at, record.embedded_at);
  return record;
}

export function getAllDocuments(): Omit<KbDocument, 'content'>[] {
  return db.prepare(`
    SELECT id, name, ext, size, status, chunk_count, error, created_at, embedded_at, doc_version
    FROM kb_documents ORDER BY created_at DESC
  `).all() as Omit<KbDocument, 'content'>[];
}

export function getDocument(id: string): KbDocument | undefined {
  return db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id) as KbDocument | undefined;
}

export async function deleteDocument(id: string): Promise<boolean> {
  // 向量 / 关键词(BM25) 索引清理
  await getVectorStore().deleteDocument(id);
  bm25Index.removeDocument(id);
  const result = db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id);
  return result.changes > 0;
}

function updateDocumentStatus(id: string, status: KbDocument['status'], extra?: { chunk_count?: number; error?: string | null; embedded_at?: string | null }) {
  db.prepare(`
    UPDATE kb_documents SET status = ?, chunk_count = COALESCE(?, chunk_count), error = ?, embedded_at = COALESCE(?, embedded_at)
    WHERE id = ?
  `).run(status, extra?.chunk_count ?? null, extra?.error ?? null, extra?.embedded_at ?? null, id);
}

// ============= 文本切片 =============

export function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    // 尝试在句子/段落边界处断开
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const breakPoints = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', '; '];
      let bestBreak = -1;
      for (const bp of breakPoints) {
        const idx = window.lastIndexOf(bp);
        if (idx > chunkSize * 0.5) { bestBreak = idx + bp.length; break; }
      }
      if (bestBreak > 0) end = start + bestBreak;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(c => c.length > 0);
}

// ============= 章节感知切片 =============

/** 识别章节标题行：Markdown 标题(# ~ ######) 与常见中文章节写法(第一章 / 1.2 / 3.1.4) */
function detectHeading(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  // Markdown 标题
  const md = /^(#{1,6})\s+(.+?)\s*$/.exec(t);
  if (md) return md[2].trim();
  // 中文「第X章/节/篇/卷」
  if (/^第[一二三四五六七八九十百千0-9]+[章节目卷篇]/.test(t)) return t;
  // 数字层级「1.2」「3.1.4」且后面跟标题文本
  if (/^[0-9]+(\.[0-9]+)+\s*[\.、]?\s*\S/.test(t)) return t;
  return null;
}

/**
 * 带章节元数据的切片：先按标题把文档切成「章节」，每节内部再用 chunkText 切，
 * 并把章节标题作为 metadata 附到每个切片上（供召回评估 / 元数据过滤使用）。
 * 整篇无标题时退化为普通 chunkText，chapter 记为 ''。
 */
export function chunkTextWithMeta(
  text: string,
  chunkSize: number,
  overlap: number,
): { content: string; chapter: string }[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  const lines = clean.split('\n');
  const sections: { chapter: string; body: string }[] = [];
  let curChapter = '';
  let curBody: string[] = [];
  const flush = () => {
    if (curBody.length) {
      sections.push({ chapter: curChapter, body: curBody.join('\n').trim() });
      curBody = [];
    }
  };
  for (const line of lines) {
    const h = detectHeading(line);
    if (h) {
      flush();
      curChapter = h;
      curBody.push(line); // 标题本身保留进正文，增强切片上下文
    } else {
      curBody.push(line);
    }
  }
  flush();

  const out: { content: string; chapter: string }[] = [];
  for (const sec of sections) {
    const pieces = chunkText(sec.body || sec.chapter, chunkSize, overlap);
    for (const p of pieces) out.push({ content: p, chapter: sec.chapter });
  }
  return out.length ? out : [{ content: clean, chapter: '' }];
}

// ============= Embedding =============

/**
 * 本地降级向量化（无需 API Key，开箱即用）：
 * 基于字符 n-gram 哈希的 512 维 TF 向量，L2 归一化。
 * 精度不如真实 Embedding 模型，但对中文文档检索有基本可用的效果。
 * 配置了 OpenAI 兼容 Embedding API 后会自动切换为 API 模式。
 */
const LOCAL_DIM = 512;

function localEmbed(text: string): number[] {
  const vec = new Array(LOCAL_DIM).fill(0);
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  // 中文按 2-gram，英文按词
  const grams: string[] = [];
  for (let i = 0; i < normalized.length - 1; i++) {
    grams.push(normalized.slice(i, i + 2));
  }
  const words = normalized.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(w => w.length > 1);
  grams.push(...words);

  for (const g of grams) {
    let h = 2166136261;
    for (let i = 0; i < g.length; i++) {
      h ^= g.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[Math.abs(h) % LOCAL_DIM] += 1;
  }
  // L2 归一化
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / norm);
}

/** 调用 OpenAI 兼容 Embedding API（批量） */
async function apiEmbed(texts: string[], settings: KbSettings): Promise<number[][]> {
  const url = settings.embeddingApiUrl.replace(/\/$/, '');
  const endpoint = url.endsWith('/embeddings') ? url : `${url}/embeddings`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.embeddingApiKey ? { Authorization: `Bearer ${settings.embeddingApiKey}` } : {}),
    },
    body: JSON.stringify({ model: settings.embeddingModel, input: texts }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Embedding API 调用失败 (${resp.status}): ${body.slice(0, 300)}`);
  }
  const data = await resp.json() as { data: Array<{ index: number; embedding: number[] }> };
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map(d => d.embedding);
}

/** 统一的向量化入口：配置了 API 则走 API，否则本地降级 */
export async function embedTexts(texts: string[]): Promise<{ vectors: number[][]; mode: 'api' | 'local' }> {
  const settings = getSettings();
  if (settings.embeddingApiUrl) {
    // 分批，避免单次请求过大
    const BATCH = 16;
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH);
      vectors.push(...await apiEmbed(batch, settings));
    }
    return { vectors, mode: 'api' };
  }
  return { vectors: texts.map(localEmbed), mode: 'local' };
}

/** 对指定文档执行切片 + 向量化 */
export async function embedDocument(docId: string): Promise<{ chunkCount: number; mode: 'api' | 'local' }> {
  const doc = getDocument(docId);
  if (!doc) throw new Error('文档不存在');

    updateDocumentStatus(docId, 'embedding');
  try {
    const settings = getSettings();
    const chunks = chunkTextWithMeta(doc.content, settings.chunkSize, settings.chunkOverlap);
    if (chunks.length === 0) throw new Error('文档内容为空，无法向量化');

    const { vectors, mode } = await embedTexts(chunks.map((c) => c.content));

    // 写入向量存储层（SQLite 默认 / pgvector 可选），由其负责切片表 + 关键词索引的维护
    await getVectorStore().upsertDocument(
      docId,
      doc.name,
      doc.doc_version,
      chunks.map((c, i) => ({ chunkIndex: i, content: c.content, vector: vectors[i], chapter: c.chapter })),
    );

    // 同步 jieba + BM25 关键词索引（增量：先删该文档旧切片，再写入新切片）
    bm25Index.upsertDocument(
      docId,
      doc.name,
      doc.doc_version,
      chunks.map((c, i) => ({ chunkIndex: i, content: c.content, chapter: c.chapter })),
    );

    updateDocumentStatus(docId, 'ready', { chunk_count: chunks.length, error: null, embedded_at: new Date().toISOString() });
    return { chunkCount: chunks.length, mode };
  } catch (e: any) {
    updateDocumentStatus(docId, 'error', { error: e?.message || String(e) });
    throw e;
  }
}

// ============= 相似度检索 =============

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** 对已检索到的切片做余弦打分、过滤、排序、截断（纯函数，便于单元测试） */
export function rankSearchResults(
  rows: Array<{ docId: string; docName: string; chunkIndex: number; content: string; embedding: string }>,
  qVec: number[],
  k: number
): SearchResult[] {
  const scored: SearchResult[] = [];
  for (const row of rows) {
    try {
      const vec = JSON.parse(row.embedding) as number[];
      const score = cosine(qVec, vec);
      if (score > 0) {
        scored.push({ docId: row.docId, docName: row.docName, chunkIndex: row.chunkIndex, content: row.content, score });
      }
    } catch { /* 跳过损坏数据 */ }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ============= 二阶段重排（rerank）配置 =============

/** 是否启用 LLM 二阶段重排（默认开启，RERANK_ENABLED=false 关闭） */
function isRerankEnabled(): boolean {
  const v = (process.env.RERANK_ENABLED ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

/** 重排候选池大小：混合检索先召回这么多，再交给 LLM 重排挑 TopK（默认 20） */
function rerankPoolSize(): number {
  const n = parseInt(process.env.RERANK_CANDIDATES ?? '20', 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** 单次重排调用超时（毫秒，默认 8000），超时则降级为 stage-1 顺序 */
function rerankTimeoutMs(): number {
  const n = parseInt(process.env.RERANK_TIMEOUT_MS ?? '8000', 10);
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

/** 每个召回支路（向量 / BM25 / FTS5）的召回条数（PDF 步骤2：各 Top-10） */
function retrieveTopKPerBranch(): number {
  const n = parseInt(process.env.RETRIEVE_TOP_K_PER_BRANCH ?? '10', 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}

/** 置信度阈值：Top-1 归一化分数低于此值视为「低置信」，触发导诊兜底（PDF 步骤2：Top-1<0.5 降级） */
function confidenceThreshold(): number {
  const n = parseFloat(process.env.TRIAGE_CONFIDENCE_THRESHOLD ?? '0.5');
  return Number.isFinite(n) ? n : 0.5;
}

/**
 * 二阶段重排编排（stage-2）：
 *  1) 优先 Cross-Encoder（CROSS_ENCODER_URL 已配置且调用成功）→ 作为主重排器；
 *  2) 否则退化到 LLM 二阶段重排（isRerankEnabled && LLM 已配置）；
 *  3) 否则保留 stage-1（RRF 融合）顺序。
 * 任何一步失败都向上一层降级，保证检索链路永不断裂。
 */
async function stage2Rerank(
  query: string,
  candidates: RerankCandidate[],
  topK: number,
): Promise<{ results: RerankCandidate[]; engine: 'cross-encoder' | 'llm' | 'stage-1' }> {
  // 1) Cross-Encoder（为主）
  if (crossEncoderUrl()) {
    const ce = await rerankWithCrossEncoder(query, candidates, { topN: topK, timeoutMs: rerankTimeoutMs() });
    if (ce && ce.length > 0) return { results: ce, engine: 'cross-encoder' };
    console.warn('[Rerank] Cross-Encoder 不可用，降级为 LLM / stage-1');
  }
  // 2) LLM 二阶段重排（降级）
  const useLLM = isRerankEnabled() && llm.isLlmConfigured();
  const llmR = await rerank(query, candidates, { topN: topK, useLLM, timeoutMs: rerankTimeoutMs() });
  return { results: llmR, engine: useLLM ? 'llm' : 'stage-1' };
}

/** 把最终检索结果的 score 线性归一到 [0.4, 1]，保证前端相关度%展示稳定 */
function normalizeScores(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return results;
  const max = results[0].score;
  const min = results[results.length - 1].score;
  return results.map((r) => ({
    ...r,
    score: max === min ? 1 : 0.4 + 0.6 * ((r.score - min) / (max - min)),
  }));
}

/** 在所有已向量化(ready)的文档中检索与 query 最相关的切片 */
export async function search(queryText: string, topK?: number): Promise<SearchResult[]> {
  const settings = getSettings();
  const k = topK ?? settings.topK;

  const store = getVectorStore();

  // 0) 缓存：相同查询直接复用检索结果（Redis/内存，见 cache.ts，默认开启）
  const ck = cacheKey(
    'search', queryText, String(k),
    process.env.RERANK_ENABLED ?? 'true',
    process.env.CROSS_ENCODER_URL ?? '',
    process.env.VECTOR_STORE ?? 'sqlite',
    process.env.QUERY_UNDERSTANDING_ENABLED ?? '',
    settings.embeddingApiUrl ? 'api' : 'local',
  );
  const cached = await getCache(ck);
  if (cached) {
    if (process.env.NODE_ENV !== 'production') console.log('[Search] 命中缓存');
    return cached as SearchResult[];
  }

  // 1) 查询理解（NER + 查询扩展）：增强召回；未启用/失败透明降级为原 query
  let retrievalQuery = queryText;
  if (queryUnderstandingEnabled()) {
    const qu = await understandQuery(queryText);
    if (qu) {
      retrievalQuery = qu.expandedQuery;
      if (process.env.NODE_ENV !== 'production')
        console.log(`[Search] 查询理解 实体=${JSON.stringify(qu.entities)} 扩展="${retrievalQuery}"`);
    }
  }

  // 2) query 向量化（用扩展后的查询，提升语义召回）
  const { vectors } = await embedTexts([retrievalQuery]);
  const qVec = vectors[0];

  // 3) 候选池：每个支路各召回 Top-10（RETRIEVE_TOP_K_PER_BRANCH），融合后取 TopK
  //    （PDF 步骤2：双路各 Top-10 → RRF → Top-5 → 重排 → Top-5）
  const branchTopK = retrieveTopKPerBranch();
  const poolSize = Math.max(branchTopK, rerankPoolSize());

  // 4) 向量检索（支路一）
  const vectorHits = await store.searchVector(qVec, branchTopK);
  const lists: SearchHit[][] = [vectorHits];

  // 5) 关键词检索：BM25(jieba 分词, 主) + FTS5/tsvector(冗余兜底)，均参与混合融合
  //    （用扩展查询检索，覆盖口语词与标准医学词；重排阶段仍用用户原问句保证相关性判据一致）
  ensureBm25Loaded();
  const bm25Hits = bm25Index.search(retrievalQuery, branchTopK);
  if (bm25Hits.length) lists.push(bm25Hits);

  if (store.searchKeyword) {
    const kwHits = await store.searchKeyword(retrievalQuery, branchTopK);
    if (kwHits.length) lists.push(kwHits);
  }

  // 5) 混合检索：Reciprocal Rank Fusion 融合多路结果（stage-1）
  const fused = reciprocalRankFusion(lists, poolSize);
  if (fused.length === 0) return [];

  // 6) 二阶段重排（stage-2）：Cross-Encoder 为主，LLM 重排作降级，再降级为 stage-1
  const candidates: RerankCandidate[] = fused.map((h) => ({
    docId: h.docId,
    docName: h.docName,
    chunkIndex: h.chunkIndex,
    content: h.content,
    score: h.score,
    source: h.source,
    chapter: h.chapter,
    docVersion: h.docVersion,
  }));
  const { results: reranked, engine } = await stage2Rerank(queryText, candidates, k);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Search] 重排引擎=${engine} 候选=${candidates.length} 命中=${reranked.length}`);
  }

  // 7) 组装为 SearchResult 并归一化 score 到 [0.4, 1]，便于前端展示「相关度 %」
  const finalResults: SearchResult[] = reranked.map((r) => ({
    docId: r.docId,
    docName: r.docName,
    chunkIndex: r.chunkIndex,
    content: r.content,
    score: r.score,
    source: r.source,
    chapter: r.chapter,
    docVersion: r.docVersion,
  }));
  const normalized = normalizeScores(finalResults);

  // 8) 置信度阈值（PDF 步骤2：Top-1<0.5 降级）：Top-1 归一化分低于阈值 → 标记低置信，
  //    由生成/导诊层据此给出「建议线下就诊」兜底，避免低置信时瞎答。
  if (normalized.length > 0 && normalized[0].score < confidenceThreshold()) {
    normalized[0].lowConfidence = true;
  }

  // 9) 写回缓存（TTL≈10min，见 cache.ts）
  await setCache(ck, normalized);
  return normalized;
}

/** 构建注入了知识库上下文的系统提示词 */
export function buildRagSystemPrompt(results: SearchResult[], customPrompt?: string): string {
  const settings = getSettings();
  const template = (customPrompt && customPrompt.trim()) || settings.ragPrompt || DEFAULT_RAG_PROMPT;

  const context = results.length > 0
    ? results.map((r, i) => {
        const chapterTag = r.chapter ? `（章节：${r.chapter}）` : '';
        return `[片段 ${i + 1}]（来源：${r.docName}${chapterTag}，相关度：${(r.score * 100).toFixed(1)}%）\n${r.content}`;
      }).join('\n\n---\n\n')
    : '（未检索到相关内容）';

  if (template.includes('{context}')) {
    return template.replace('{context}', context);
  }
  // 提示词中没写 {context} 占位符时，自动在末尾附加参考内容
  return `${template}\n\n【知识库参考内容】\n${context}`;
}

/** 是否存在已就绪的知识库文档 */
export function hasReadyDocuments(): boolean {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM kb_documents WHERE status = 'ready'").get() as { cnt: number };
  return row.cnt > 0;
}

// ============= 导出 / 导入备份 =============

export interface KbBackup {
  version: number;
  exportedAt: string;
  documents: any[];
  chunks: any[];
  settings: Record<string, string>;
}

/** 导出整个知识库（文档 + 切片向量 + 设置） */
export function exportKb(): KbBackup {
  const documents = db.prepare('SELECT * FROM kb_documents').all();
  const chunks = db.prepare('SELECT * FROM kb_chunks').all();
  const rows = db.prepare('SELECT key, value FROM kb_settings').all() as Array<{ key: string; value: string }>;
  const settings: Record<string, string> = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    documents,
    chunks,
    settings,
  };
}

/**
 * 导入知识库备份（覆盖式：先清空现有 kb 数据再写入）。
 * 返回导入的文档数与切片数。
 */
export function importKb(payload: Partial<KbBackup>): { docCount: number; chunkCount: number } {
  const documents = Array.isArray(payload.documents) ? payload.documents : [];
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};

  const insDoc = db.prepare(`
    INSERT INTO kb_documents (id, name, ext, size, content, status, chunk_count, error, created_at, embedded_at, doc_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insChunk = db.prepare(`
    INSERT INTO kb_chunks (id, doc_id, chunk_index, content, embedding, chapter, doc_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insSet = db.prepare(`
    INSERT INTO kb_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks').run();
    db.prepare('DELETE FROM kb_documents').run();
    db.prepare('DELETE FROM kb_settings').run();
    for (const d of documents as any[]) {
      insDoc.run(d.id, d.name, d.ext, d.size, d.content, d.status, d.chunk_count, d.error, d.created_at, d.embedded_at, d.doc_version ?? '1');
    }
    for (const c of chunks as any[]) {
      insChunk.run(c.id, c.doc_id, c.chunk_index, c.content, c.embedding, c.chapter ?? '', c.doc_version ?? '1');
    }
    for (const [k, v] of Object.entries(settings)) {
      insSet.run(k, String(v));
    }
  });
  tx();

  // BM25 为内存索引，导入覆盖后需从新数据重建
  rebuildBm25FromDb();

  return { docCount: documents.length, chunkCount: chunks.length };
}

/**
 * 从 kb_chunks 全量重建 BM25 关键词索引。
 * 在服务启动后首次搜索、或导入备份后调用（BM25 是内存结构，重启不持久）。
 */
export function rebuildBm25FromDb(): void {
  const rows = db.prepare(`
    SELECT c.doc_id as docId, d.name as docName, c.chunk_index as chunkIndex,
           c.content, c.chapter, c.doc_version as docVersion
    FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
  `).all() as Array<{ docId: string; docName: string; chunkIndex: number; content: string; chapter: string; docVersion: string }>;
  bm25Index.rebuild(
    rows.map((r) => ({
      chunkId: `${r.docId}#${r.chunkIndex}`,
      docId: r.docId,
      docName: r.docName,
      chunkIndex: r.chunkIndex,
      content: r.content,
      chapter: r.chapter || undefined,
      docVersion: r.docVersion,
    })),
  );
}

/**
 * 懒加载 + 自愈：BM25 为空、或索引切片数与数据库不一致时重建。
 * 不一致的常见场景：其他进程写入（如 `npm run seed` 批量导入语料）、
 * 导入备份覆盖、文档删除。改造前仅在 size===0 时重建，会导致「外部进程
 * 新增的语料在重启前永远检索不到」——现在下一次检索即可自动感知。
 */
function ensureBm25Loaded(): void {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id`,
    )
    .get() as { cnt: number };
  if (bm25Index.size !== row.cnt) rebuildBm25FromDb();
}
