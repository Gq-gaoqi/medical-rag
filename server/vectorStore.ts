/**
 * 向量存储抽象层 (VectorStore)
 * ------------------------------------------------------------
 * 设计目的：把「切片向量存哪、怎么检索」与业务(kb.js)解耦。
 * - 默认实现 SqliteStore：零依赖、单文件、易备份，适合本地 / 个人知识库。
 * - 可选实现 PgVectorStore：走 Postgres + pgvector 扩展，获得 ANN 索引
 *   (HNSW) 与并发检索能力，适合生产 / 大规模语料。
 *
 * 通过环境变量 VECTOR_STORE=sqlite|pgvector|chroma 切换，属于「配置级改动」，
 * 业务代码(kb.js)无需感知底层用的是什么存储。
 *
 * 检索策略：支持向量检索(searchVector)与关键词检索(searchKeyword)两套，
 * 上层用 reciprocalRankFusion 做混合检索(hybrid search)融合。
 */
import db from './db.js';
import { v4 as uuidv4 } from 'uuid';

/** 一个切片 + 它的向量，交给 VectorStore 持久化 */
export interface ChunkInput {
  chunkIndex: number;
  content: string;
  vector: number[];
  /** 所属章节标题（如 "# 用药须知"），用于元数据过滤与召回评估 */
  chapter?: string;
  /** 文档版本（同一文档多次更新时区分），默认 '1' */
  docVersion?: string;
}

/** 检索命中结果 */
export interface SearchHit {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  /** 融合后(或单一)的相关性分数，建议归一化到 0~1 便于展示 */
  score: number;
  source: 'vector' | 'keyword' | 'hybrid';
  /** 命中切片所属章节（可选） */
  chapter?: string;
  /** 命中切片所属文档版本（可选） */
  docVersion?: string;
}

/**
 * 向量存储接口：所有存储后端都实现它。
 * 业务层只依赖这个接口，不关心底层是 SQLite 还是 pgvector。
 */
export interface VectorStore {
  /** 后端名称，用于日志 / 调试 */
  readonly name: string;
  /** 是否支持关键词检索(用于 hybrid) */
  readonly supportsKeyword: boolean;
  /** 写入(或覆盖)某个文档的所有切片向量（docVersion 为文档级版本号） */
  upsertDocument(docId: string, docName: string, docVersion: string, chunks: ChunkInput[]): Promise<void>;
  /** 删除某文档的全部切片 */
  deleteDocument(docId: string): Promise<void>;
  /** 向量相似度检索，返回 topK */
  searchVector(queryVec: number[], topK: number): Promise<SearchHit[]>;
  /** 关键词检索(可选，依赖存储后端能力) */
  searchKeyword?(query: string, topK: number): Promise<SearchHit[]>;
  /** 关闭连接(可选) */
  close?(): Promise<void>;
}

// ============= 通用工具 =============

/** 余弦相似度，未归一化向量也能用 */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Reciprocal Rank Fusion：把多路召回结果按排名融合。
 * 比简单分数加权更鲁棒(不要求各路分数同量纲)。k 为平滑常数。
 */
export function reciprocalRankFusion(lists: SearchHit[][], topK: number, k = 60): SearchHit[] {
  const fused = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, idx) => {
      const key = `${hit.docId}#${hit.chunkIndex}`;
      const rrf = 1 / (k + idx + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += rrf;
        // 保留信息更全的那条(优先带 docName)
        if (!existing.hit.docName && hit.docName) existing.hit = { ...hit, source: 'hybrid' };
      } else {
        fused.set(key, { hit: { ...hit, source: 'hybrid' }, score: rrf });
      }
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => ({ ...x.hit, score: x.score }));
}

// ============= SQLite 实现(默认) =============
class SqliteStore implements VectorStore {
  readonly name = 'sqlite';
  readonly supportsKeyword = true;
  private readonly db = db;

  constructor() {
    // 切片 + 向量表(从 kb.js 迁移过来，保证不依赖导入顺序也会建表)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT,
        FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc_id ON kb_chunks(doc_id);
    `);
    // 关键词检索表：FTS5 trigram 分词器，对中文子串友好 + 原生 BM25 排序
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        doc_id UNINDEXED,
        doc_name UNINDEXED,
        chunk_index UNINDEXED,
        content,
        tokenize='trigram'
      );
    `);
    // 迁移：为已有库补充章节 / 版本元数据列（幂等，兼容旧库）
    try {
      const cols = this.db.prepare('PRAGMA table_info(kb_chunks)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'chapter')) {
        this.db.exec("ALTER TABLE kb_chunks ADD COLUMN chapter TEXT NOT NULL DEFAULT ''");
      }
      if (!cols.some((c) => c.name === 'doc_version')) {
        this.db.exec("ALTER TABLE kb_chunks ADD COLUMN doc_version TEXT NOT NULL DEFAULT '1'");
      }
    } catch {
      /* 忽略（列可能已存在） */
    }
  }

  async upsertDocument(docId: string, docName: string, docVersion: string, chunks: ChunkInput[]): Promise<void> {
    const delC = this.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?');
    const delF = this.db.prepare("DELETE FROM kb_chunks_fts WHERE doc_id = ?");
    const insC = this.db.prepare(
      'INSERT INTO kb_chunks (id, doc_id, chunk_index, content, embedding, chapter, doc_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insF = this.db.prepare(
      'INSERT INTO kb_chunks_fts (chunk_id, doc_id, doc_name, chunk_index, content) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.transaction((id: string, name: string, dv: string, cs: ChunkInput[]) => {
      delC.run(id);
      delF.run(id);
      for (const c of cs) {
        const cid = uuidv4();
        insC.run(cid, id, c.chunkIndex, c.content, JSON.stringify(c.vector), c.chapter ?? '', dv);
        insF.run(cid, id, name, c.chunkIndex, c.content);
      }
    });
    tx(docId, docName, docVersion, chunks);
  }

  async deleteDocument(docId: string): Promise<void> {
    this.db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId);
    this.db.prepare('DELETE FROM kb_chunks_fts WHERE doc_id = ?').run(docId);
  }

  async searchVector(queryVec: number[], topK: number): Promise<SearchHit[]> {
    const rows = this.db
      .prepare(
        `SELECT c.doc_id as docId, d.name as docName, c.chunk_index as chunkIndex, c.content, c.embedding, c.chapter, c.doc_version as docVersion
         FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
         WHERE d.status = 'ready' AND c.embedding IS NOT NULL`,
      )
      .all();
    const scored: SearchHit[] = [];
    for (const r of rows as any[]) {
      try {
        const vec = JSON.parse(r.embedding);
        const s = cosine(queryVec, vec);
        if (s > 0) {
          scored.push({
            docId: r.docId,
            docName: r.docName,
            chunkIndex: r.chunkIndex,
            content: r.content,
            score: s,
            source: 'vector',
            chapter: r.chapter || undefined,
            docVersion: r.docVersion || undefined,
          });
        }
      } catch {
        /* 跳过损坏数据 */
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async searchKeyword(query: string, topK: number): Promise<SearchHit[]> {
    // 清洗标点，保留中英文与数字
    const q = query
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // trigram 要求查询至少 3 个字符，更短的走 LIKE 兜底
    if (q.length < 3) return this.likeFallback(query, topK);
    let rows: any[];
    try {
      rows = this.db
        .prepare(
          `SELECT f.chunk_id, f.doc_id, f.doc_name, f.chunk_index, f.content, c.chapter, c.doc_version as docVersion, bm25(kb_chunks_fts) AS rank
           FROM kb_chunks_fts f JOIN kb_chunks c ON c.id = f.chunk_id
           WHERE kb_chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(q, topK * 3);
    } catch {
      return this.likeFallback(query, topK);
    }
    if (rows.length === 0) {
      const lk = await this.likeFallback(query, topK);
      if (lk.length) return lk;
    }
    return rows.map((r) => ({
      docId: r.doc_id,
      docName: r.doc_name,
      chunkIndex: r.chunk_index,
      content: r.content,
      // bm25 rank 越小越相关(可正可负)，取 1/(1+|rank|) 归一
      score: 1 / (1 + Math.abs(r.rank)),
      source: 'keyword' as const,
      chapter: r.chapter || undefined,
      docVersion: r.docVersion || undefined,
    }));
  }

  /** 关键词检索的兜底：直接对切片内容做 LIKE，保证至少能命中字面子串 */
  private async likeFallback(query: string, topK: number): Promise<SearchHit[]> {
    const term = query.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 20);
    if (!term) return [];
    const rows = this.db
      .prepare(
        `SELECT c.doc_id as docId, d.name as docName, c.chunk_index as chunkIndex, c.content, c.chapter, c.doc_version as docVersion
         FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
         WHERE d.status = 'ready' AND c.content LIKE ? LIMIT ?`,
      )
      .all(`%${term}%`, topK);
    return (rows as any[]).map((r) => ({
      docId: r.docId,
      docName: r.docName,
      chunkIndex: r.chunkIndex,
      content: r.content,
      score: 0.5,
      source: 'keyword' as const,
      chapter: r.chapter || undefined,
      docVersion: r.docVersion || undefined,
    }));
  }
}

// ============= pgvector 实现(可选 / 生产) =============
/**
 * 走 Postgres + pgvector 扩展。获得：
 *  - 真正的 ANN 索引(HNSW)，大规模向量检索从 O(N) 暴力扫描降到对数级
 *  - 并发连接池，支持多用户 / 高 QPS
 * 'pg' 是可选依赖：仅当 VECTOR_STORE=pgvector 时才动态加载，
 * 因此本地默认(sqlite)启动不要求安装 pg，也不要求有 Postgres 实例。
 */
class PgVectorStore implements VectorStore {
  readonly name = 'pgvector';
  readonly supportsKeyword = true;
  private pool: any = null;
  private readonly dimension: number;

  constructor(private readonly connectionString: string) {
    this.dimension = parseInt(process.env.VECTOR_DIM || '1536', 10) || 1536;
  }

  private async getPool(): Promise<any> {
    if (!this.pool) {
      // @ts-ignore optional peer dependency, only required in pgvector mode
      const pg = (await import('pg')).default;
      this.pool = new pg.Pool({ connectionString: this.connectionString });
    }
    return this.pool;
  }

  /** 首次使用时建扩展 + 表 + HNSW 索引(幂等) */
  private async initSchema(): Promise<void> {
    const pool = await this.getPool();
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        doc_id UUID NOT NULL,
        doc_name TEXT,
        chunk_index INT NOT NULL,
        content TEXT NOT NULL,
        embedding vector(${this.dimension}),
        chapter TEXT NOT NULL DEFAULT '',
        doc_version TEXT NOT NULL DEFAULT '1'
      )
    `);
    await pool.query(
      'CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops)',
    );
    await pool.query('CREATE INDEX IF NOT EXISTS kb_chunks_doc_id_idx ON kb_chunks (doc_id)');
    // 迁移：为已有 pg 表补充章节 / 版本元数据列
    await pool.query('ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS chapter TEXT DEFAULT \'\'');
    await pool.query("ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS doc_version TEXT DEFAULT '1'");
  }

  async upsertDocument(docId: string, docName: string, docVersion: string, chunks: ChunkInput[]): Promise<void> {
    const pool = await this.getPool();
    await this.initSchema();
    const client = await pool.connect();
    try {
      await client.query('DELETE FROM kb_chunks WHERE doc_id = $1', [docId]);
      for (const c of chunks) {
        await client.query(
          `INSERT INTO kb_chunks (doc_id, doc_name, chunk_index, content, embedding, chapter, doc_version)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [docId, docName, c.chunkIndex, c.content, `[${c.vector.join(',')}]`, c.chapter ?? '', docVersion],
        );
      }
    } finally {
      client.release();
    }
  }

  async deleteDocument(docId: string): Promise<void> {
    const pool = await this.getPool();
    await pool.query('DELETE FROM kb_chunks WHERE doc_id = $1', [docId]);
  }

  async searchVector(queryVec: number[], topK: number): Promise<SearchHit[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query(
      `SELECT doc_id, doc_name, chunk_index, content, chapter, doc_version, 1 - (embedding <=> $1) AS score
       FROM kb_chunks ORDER BY embedding <=> $1 LIMIT $2`,
      [`[${queryVec.join(',')}]`, topK],
    );
    return rows.map((r: any) => ({
      docId: r.doc_id,
      docName: r.doc_name,
      chunkIndex: r.chunk_index,
      content: r.content,
      score: r.score,
      source: 'vector' as const,
      chapter: r.chapter || undefined,
      docVersion: r.doc_version || undefined,
    }));
  }

  async searchKeyword(query: string, topK: number): Promise<SearchHit[]> {
    const pool = await this.getPool();
    const { rows } = await pool.query(
      `SELECT doc_id, doc_name, chunk_index, content, chapter, doc_version,
              ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $1)) AS score
       FROM kb_chunks
       WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', $1)
       ORDER BY score DESC LIMIT $2`,
      [query, topK],
    );
    return rows.map((r: any) => ({
      docId: r.doc_id,
      docName: r.doc_name,
      chunkIndex: r.chunk_index,
      content: r.content,
      score: r.score,
      source: 'keyword' as const,
      chapter: r.chapter || undefined,
      docVersion: r.doc_version || undefined,
    }));
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

// ============= Chroma 实现(可选 / 独立向量服务) =============
/**
 * 走 Chroma 向量数据库（以独立服务形式运行，建议 docker 启动）。获得：
 *  - 独立的 ANN 向量服务，与业务进程解耦，便于横向扩展
 *  - 原生 where_document 关键词过滤能力，可走 hybrid
 * 'chromadb' 是可选依赖：仅当 VECTOR_STORE=chroma 时才动态加载，
 * 本地默认(sqlite)启动不要求安装 chromadb，也不要求有 Chroma 实例。
 */
class ChromaStore implements VectorStore {
  readonly name = 'chroma';
  readonly supportsKeyword = true;
  private client: any = null;
  private collection: any = null;
  private readonly collectionName = process.env.CHROMA_COLLECTION || 'kb_chunks';

  constructor(private readonly url: string) {}

  private async getCollection(): Promise<any> {
    if (!this.client) {
      // @ts-ignore optional peer dependency, only required in chroma mode
      const chromadb = (await import('chromadb')).default;
      this.client = new chromadb.ChromaClient({ path: this.url });
    }
    if (!this.collection) {
      this.collection = await this.client.getOrCreateCollection({ name: this.collectionName });
    }
    return this.collection;
  }

  async upsertDocument(docId: string, docName: string, docVersion: string, chunks: ChunkInput[]): Promise<void> {
    const col = await this.getCollection();
    await col.upsert({
      ids: chunks.map((c) => `${docId}#${c.chunkIndex}`),
      embeddings: chunks.map((c) => c.vector),
      documents: chunks.map((c) => c.content),
      metadatas: chunks.map((c) => ({
        docId,
        docName,
        chunkIndex: c.chunkIndex,
        chapter: c.chapter ?? '',
        docVersion,
      })),
    });
  }

  async deleteDocument(docId: string): Promise<void> {
    const col = await this.getCollection();
    const existing = await col.get({ where: { docId } });
    if (existing.ids && existing.ids.length) await col.delete({ ids: existing.ids });
  }

  async searchVector(queryVec: number[], topK: number): Promise<SearchHit[]> {
    const col = await this.getCollection();
    const res = await col.query({ queryEmbeddings: [queryVec], nResults: topK });
    const ids: string[] = res.ids?.[0] || [];
    const docs: string[] = res.documents?.[0] || [];
    const metas: any[] = res.metadatas?.[0] || [];
    const dists: number[] = res.distances?.[0] || [];
    return ids.map((_id, i) => {
      const m = metas[i] || {};
      return {
        docId: m.docId,
        docName: m.docName,
        chunkIndex: m.chunkIndex,
        content: docs[i] || '',
        // Chroma 默认返回余弦距离，转成 0~1 相似度便于展示
        score: 1 - (dists[i] ?? 1),
        source: 'vector' as const,
        chapter: m.chapter || undefined,
        docVersion: m.docVersion || undefined,
      };
    });
  }

  async searchKeyword(query: string, topK: number): Promise<SearchHit[]> {
    const col = await this.getCollection();
    const q = query.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    const terms = q.split(/\s+/).filter(Boolean);
    const res = await col.get({ where_document: { $contains: q }, limit: topK * 3 });
    const ids: string[] = res.ids || [];
    const docs: string[] = res.documents || [];
    const metas: any[] = res.metadatas || [];
    const denom = terms.length || 1;
    return ids
      .map((_id, i) => {
        const m = metas[i] || {};
        const content = docs[i] || '';
        const hit = terms.filter((t) => content.includes(t)).length;
        return {
          docId: m.docId,
          docName: m.docName,
          chunkIndex: m.chunkIndex,
          content,
          score: 0.4 + 0.6 * (hit / denom),
          source: 'keyword' as const,
          chapter: m.chapter || undefined,
          docVersion: m.docVersion || undefined,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async close(): Promise<void> {
    // chromadb 客户端无显式 close 接口，留空
  }
}

// ============= 工厂 =============
let _sqlite: SqliteStore | null = null;

/**
 * 获取当前配置下的向量存储实例。
 * 默认 sqlite(零依赖)；设置 VECTOR_STORE=pgvector|chroma 时切换到对应后端。
 */
export function getVectorStore(): VectorStore {
  const kind = (process.env.VECTOR_STORE || 'sqlite').toLowerCase();
  if (kind === 'pgvector') {
    const url = process.env.PGVECTOR_URL || process.env.DATABASE_URL || '';
    if (!url) {
      throw new Error('VECTOR_STORE=pgvector 需要设置 PGVECTOR_URL 或 DATABASE_URL 环境变量');
    }
    return new PgVectorStore(url);
  }
  if (kind === 'chroma') {
    const url = process.env.CHROMA_URL || 'http://localhost:8000';
    return new ChromaStore(url);
  }
  if (!_sqlite) _sqlite = new SqliteStore();
  return _sqlite;
}
