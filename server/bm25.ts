/**
 * 关键词检索：jieba 分词 + BM25 Okapi 算法
 * ------------------------------------------------------------
 * 这是 RAG 混合检索里「关键词支路」的高质量实现，替代 / 增强原有的
 * FTS5 trigram（SQLite）/ tsvector（PG）字面子串匹配。
 *
 * 为什么用 jieba + BM25（而非纯字面子串）：
 *  - 中文没有空格分词，FTS5 trigram 本质是「字面子串」匹配，对
 *    "高血压" 与 "降压药" 这类「语义近、字面不重叠」的医疗词召回弱。
 *  - jieba 切出"高血压 / 降压 / 药物"等词元，BM25 在词粒度排序，
 *    并用 IDF 抑制"的 / 患者 / 服用"等高泛词，召回更准。
 *
 * 索引为内存结构，通过 upsertDocument / removeDocument 增量维护，
 * rebuild() 从数据库全量重建（导入备份 / 服务重启后调用）。
 * chunk 主键用 `docId#chunkIndex` 组合键，避免依赖向量层内部 UUID。
 */
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';
import type { SearchHit } from './vectorStore.js';

// 单例分词器：加载默认通用词典（含大量医疗/科技词），模块级初始化一次
const jieba = Jieba.withDict(dict);

// BM25 Okapi 经典超参
const K1 = 1.5;
const B = 0.75;

export interface Bm25ChunkInput {
  chunkId: string;
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  chapter?: string;
  docVersion?: string;
}

interface Bm25Entry {
  chunkId: string;
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  chapter?: string;
  docVersion?: string;
  termFreq: Map<string, number>;
  length: number;
}

export class Bm25Index {
  private docs = new Map<string, Bm25Entry>();
  private postings = new Map<string, Set<string>>(); // term -> chunkIds
  private docChunks = new Map<string, Set<string>>(); // docId -> chunkIds
  private df = new Map<string, number>(); // term -> 含该词的 chunk 数
  private totalLen = 0;

  get size(): number {
    return this.docs.size;
  }

  /** 分词：索引与查询统一用 cutForSearch，使子词也能召回（"血压" 命中 "高血压"） */
  private tokenize(text: string): string[] {
    return jieba
      .cutForSearch(text, false)
      .filter((t) => t && t.trim().length > 0);
  }

  /** 写入 / 覆盖一个切片（同一 chunkId 会先删后插，幂等） */
  addDocument(input: Bm25ChunkInput): void {
    this.removeChunk(input.chunkId);
    const terms = this.tokenize(input.content);
    const termFreq = new Map<string, number>();
    for (const t of terms) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

    const entry: Bm25Entry = {
      chunkId: input.chunkId,
      docId: input.docId,
      docName: input.docName,
      chunkIndex: input.chunkIndex,
      content: input.content,
      chapter: input.chapter,
      docVersion: input.docVersion,
      termFreq,
      length: terms.length,
    };
    this.docs.set(input.chunkId, entry);

    let set = this.docChunks.get(input.docId);
    if (!set) {
      set = new Set();
      this.docChunks.set(input.docId, set);
    }
    set.add(input.chunkId);

    for (const term of termFreq.keys()) {
      let p = this.postings.get(term);
      if (!p) {
        p = new Set();
        this.postings.set(term, p);
      }
      const isNew = !p.has(input.chunkId);
      p.add(input.chunkId);
      if (isNew) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
    this.totalLen += entry.length;
  }

  private removeChunk(chunkId: string): void {
    const old = this.docs.get(chunkId);
    if (!old) return;
    for (const term of old.termFreq.keys()) {
      const p = this.postings.get(term);
      if (!p) continue;
      p.delete(chunkId);
      if (p.size === 0) {
        this.postings.delete(term);
        this.df.delete(term);
      } else {
        // df 始终与倒排表规模保持一致
        this.df.set(term, p.size);
      }
    }
    this.totalLen -= old.length;
    this.docs.delete(chunkId);
    const set = this.docChunks.get(old.docId);
    if (set) {
      set.delete(chunkId);
      if (set.size === 0) this.docChunks.delete(old.docId);
    }
  }

  /** 删除某文档的全部切片 */
  removeDocument(docId: string): void {
    const set = this.docChunks.get(docId);
    if (!set) return;
    for (const cid of [...set]) this.removeChunk(cid);
  }

  /** 覆盖式批量写入某文档的全部切片（先删后插，幂等） */
  upsertDocument(
    docId: string,
    docName: string,
    docVersion: string,
    chunks: Array<{ chunkIndex: number; content: string; chapter?: string }>,
  ): void {
    this.removeDocument(docId);
    chunks.forEach((c, i) => {
      this.addDocument({
        chunkId: `${docId}#${i}`,
        docId,
        docName,
        docVersion: docVersion || '1',
        chunkIndex: i,
        content: c.content,
        chapter: c.chapter,
      });
    });
  }

  /** 清空并批量重建（导入备份 / 重启恢复用） */
  rebuild(chunks: Bm25ChunkInput[]): void {
    this.docs.clear();
    this.postings.clear();
    this.docChunks.clear();
    this.df.clear();
    this.totalLen = 0;
    for (const c of chunks) this.addDocument(c);
  }

  /** BM25 Okapi 检索，返回 topK 命中（score 已 min-max 归一到 (0,1]） */
  search(query: string, topK: number): SearchHit[] {
    if (this.docs.size === 0) return [];
    const qTerms = this.tokenize(query);
    if (qTerms.length === 0) return [];

    const N = this.docs.size;
    const avgdl = this.totalLen / N;
    const scores = new Map<string, number>();
    const seen = new Set<string>();

    for (const qt of qTerms) {
      if (seen.has(qt)) continue; // 查询词重复只计一次贡献
      seen.add(qt);
      const posting = this.postings.get(qt);
      if (!posting || posting.size === 0) continue;
      const df = this.df.get(qt) ?? 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      for (const cid of posting) {
        const d = this.docs.get(cid)!;
        const f = d.termFreq.get(qt) ?? 0;
        if (f === 0) continue;
        const denom = (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.length / avgdl)));
        scores.set(cid, (scores.get(cid) ?? 0) + idf * denom);
      }
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    if (ranked.length === 0) return [];

    const max = ranked[0][1];
    const min = ranked[ranked.length - 1][1];
    return ranked.map(([cid, raw]) => {
      const d = this.docs.get(cid)!;
      const score = max === min ? 1 : 0.4 + 0.6 * ((raw - min) / (max - min));
      return {
        docId: d.docId,
        docName: d.docName,
        chunkIndex: d.chunkIndex,
        content: d.content,
        score,
        source: 'keyword' as const,
        chapter: d.chapter,
        docVersion: d.docVersion,
      } as SearchHit;
    });
  }
}

/** 全局单例：整个服务进程共享一份关键词索引 */
export const bm25Index = new Bm25Index();
