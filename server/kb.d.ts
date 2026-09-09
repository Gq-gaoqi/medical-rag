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
}
export interface KbSettings {
    embeddingApiUrl: string;
    embeddingApiKey: string;
    embeddingModel: string;
    ragPrompt: string;
    topK: number;
    chunkSize: number;
    chunkOverlap: number;
}
export declare const DEFAULT_RAG_PROMPT = "\u4F60\u662F\u6211\u7684\u4E2A\u4EBA\u77E5\u8BC6\u5E93\u52A9\u624B\u3002\u8BF7\u4E25\u683C\u57FA\u4E8E\u4E0B\u9762\u63D0\u4F9B\u7684\u3010\u77E5\u8BC6\u5E93\u53C2\u8003\u5185\u5BB9\u3011\u56DE\u7B54\u7528\u6237\u7684\u95EE\u9898\u3002\n\n\u8981\u6C42\uFF1A\n1. \u53EA\u4F7F\u7528\u53C2\u8003\u5185\u5BB9\u4E2D\u7684\u4FE1\u606F\u56DE\u7B54\uFF0C\u4E0D\u8981\u7F16\u9020\u3002\n2. \u5982\u679C\u53C2\u8003\u5185\u5BB9\u4E2D\u6CA1\u6709\u76F8\u5173\u4FE1\u606F\uFF0C\u8BF7\u660E\u786E\u544A\u77E5\"\u77E5\u8BC6\u5E93\u4E2D\u6CA1\u6709\u627E\u5230\u76F8\u5173\u5185\u5BB9\"\uFF0C\u518D\u7ED9\u51FA\u4F60\u81EA\u5DF1\u7684\u4E00\u822C\u6027\u5EFA\u8BAE\u3002\n3. \u56DE\u7B54\u65F6\u53EF\u6CE8\u660E\u4FE1\u606F\u6765\u81EA\u54EA\u4E2A\u6587\u6863\u3002\n\n\u3010\u77E5\u8BC6\u5E93\u53C2\u8003\u5185\u5BB9\u3011\n{context}";
export declare function getSettings(): KbSettings;
export declare function saveSettings(updates: Partial<KbSettings>): KbSettings;
export declare function createDocument(doc: {
    name: string;
    ext: string;
    size: number;
    content: string;
}): KbDocument;
export declare function getAllDocuments(): Omit<KbDocument, 'content'>[];
export declare function getDocument(id: string): KbDocument | undefined;
export declare function deleteDocument(id: string): boolean;
export declare function chunkText(text: string, chunkSize: number, overlap: number): string[];
/** 统一的向量化入口：配置了 API 则走 API，否则本地降级 */
export declare function embedTexts(texts: string[]): Promise<{
    vectors: number[][];
    mode: 'api' | 'local';
}>;
/** 对指定文档执行切片 + 向量化 */
export declare function embedDocument(docId: string): Promise<{
    chunkCount: number;
    mode: 'api' | 'local';
}>;
/** 在所有已向量化(ready)的文档中检索与 query 最相关的切片 */
export declare function search(queryText: string, topK?: number): Promise<SearchResult[]>;
/** 构建注入了知识库上下文的系统提示词 */
export declare function buildRagSystemPrompt(results: SearchResult[], customPrompt?: string): string;
/** 是否存在已就绪的知识库文档 */
export declare function hasReadyDocuments(): boolean;
