var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
/**
 * 知识库模块：文档管理、切片、向量化 Embedding、相似度检索
 */
import db from './db.js';
import { v4 as uuidv4 } from 'uuid';
// ============= 表结构初始化 =============
db.exec("\n  -- \u77E5\u8BC6\u5E93\u6587\u6863\u8868\n  CREATE TABLE IF NOT EXISTS kb_documents (\n    id TEXT PRIMARY KEY,\n    name TEXT NOT NULL,\n    ext TEXT NOT NULL,\n    size INTEGER NOT NULL,\n    content TEXT NOT NULL,\n    status TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded | embedding | ready | error\n    chunk_count INTEGER NOT NULL DEFAULT 0,\n    error TEXT,\n    created_at TEXT NOT NULL,\n    embedded_at TEXT\n  );\n\n  -- \u6587\u6863\u5207\u7247 + \u5411\u91CF\u8868\n  CREATE TABLE IF NOT EXISTS kb_chunks (\n    id TEXT PRIMARY KEY,\n    doc_id TEXT NOT NULL,\n    chunk_index INTEGER NOT NULL,\n    content TEXT NOT NULL,\n    embedding TEXT,                            -- JSON \u6570\u7EC4\n    FOREIGN KEY (doc_id) REFERENCES kb_documents(id) ON DELETE CASCADE\n  );\n  CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc_id ON kb_chunks(doc_id);\n\n  -- \u77E5\u8BC6\u5E93\u8BBE\u7F6E\u8868\uFF08key-value\uFF09\n  CREATE TABLE IF NOT EXISTS kb_settings (\n    key TEXT PRIMARY KEY,\n    value TEXT\n  );\n");
// 默认 RAG 提示词 —— 用户可在前端「知识库」页面完全自定义
export var DEFAULT_RAG_PROMPT = "\u4F60\u662F\u6211\u7684\u4E2A\u4EBA\u77E5\u8BC6\u5E93\u52A9\u624B\u3002\u8BF7\u4E25\u683C\u57FA\u4E8E\u4E0B\u9762\u63D0\u4F9B\u7684\u3010\u77E5\u8BC6\u5E93\u53C2\u8003\u5185\u5BB9\u3011\u56DE\u7B54\u7528\u6237\u7684\u95EE\u9898\u3002\n\n\u8981\u6C42\uFF1A\n1. \u53EA\u4F7F\u7528\u53C2\u8003\u5185\u5BB9\u4E2D\u7684\u4FE1\u606F\u56DE\u7B54\uFF0C\u4E0D\u8981\u7F16\u9020\u3002\n2. \u5982\u679C\u53C2\u8003\u5185\u5BB9\u4E2D\u6CA1\u6709\u76F8\u5173\u4FE1\u606F\uFF0C\u8BF7\u660E\u786E\u544A\u77E5\"\u77E5\u8BC6\u5E93\u4E2D\u6CA1\u6709\u627E\u5230\u76F8\u5173\u5185\u5BB9\"\uFF0C\u518D\u7ED9\u51FA\u4F60\u81EA\u5DF1\u7684\u4E00\u822C\u6027\u5EFA\u8BAE\u3002\n3. \u56DE\u7B54\u65F6\u53EF\u6CE8\u660E\u4FE1\u606F\u6765\u81EA\u54EA\u4E2A\u6587\u6863\u3002\n\n\u3010\u77E5\u8BC6\u5E93\u53C2\u8003\u5185\u5BB9\u3011\n{context}";
var DEFAULT_SETTINGS = {
    embeddingApiUrl: '',
    embeddingApiKey: '',
    embeddingModel: 'text-embedding-3-small',
    ragPrompt: DEFAULT_RAG_PROMPT,
    topK: 4,
    chunkSize: 800,
    chunkOverlap: 100,
};
// ============= 设置操作 =============
export function getSettings() {
    var _a, _b, _c, _d, _e, _f, _g;
    var rows = db.prepare('SELECT key, value FROM kb_settings').all();
    var map = {};
    rows.forEach(function (r) { map[r.key] = r.value; });
    return {
        embeddingApiUrl: (_b = (_a = map.embeddingApiUrl) !== null && _a !== void 0 ? _a : process.env.EMBEDDING_API_URL) !== null && _b !== void 0 ? _b : DEFAULT_SETTINGS.embeddingApiUrl,
        embeddingApiKey: (_d = (_c = map.embeddingApiKey) !== null && _c !== void 0 ? _c : process.env.EMBEDDING_API_KEY) !== null && _d !== void 0 ? _d : DEFAULT_SETTINGS.embeddingApiKey,
        embeddingModel: (_f = (_e = map.embeddingModel) !== null && _e !== void 0 ? _e : process.env.EMBEDDING_MODEL) !== null && _f !== void 0 ? _f : DEFAULT_SETTINGS.embeddingModel,
        ragPrompt: (_g = map.ragPrompt) !== null && _g !== void 0 ? _g : DEFAULT_SETTINGS.ragPrompt,
        topK: map.topK ? parseInt(map.topK, 10) : DEFAULT_SETTINGS.topK,
        chunkSize: map.chunkSize ? parseInt(map.chunkSize, 10) : DEFAULT_SETTINGS.chunkSize,
        chunkOverlap: map.chunkOverlap ? parseInt(map.chunkOverlap, 10) : DEFAULT_SETTINGS.chunkOverlap,
    };
}
export function saveSettings(updates) {
    var stmt = db.prepare('INSERT INTO kb_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (var _i = 0, _a = Object.entries(updates); _i < _a.length; _i++) {
        var _b = _a[_i], key = _b[0], value = _b[1];
        if (value !== undefined && value !== null) {
            stmt.run(key, String(value));
        }
    }
    return getSettings();
}
// ============= 文档操作 =============
export function createDocument(doc) {
    var record = {
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
    };
    db.prepare("\n    INSERT INTO kb_documents (id, name, ext, size, content, status, chunk_count, error, created_at, embedded_at)\n    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n  ").run(record.id, record.name, record.ext, record.size, record.content, record.status, record.chunk_count, record.error, record.created_at, record.embedded_at);
    return record;
}
export function getAllDocuments() {
    return db.prepare("\n    SELECT id, name, ext, size, status, chunk_count, error, created_at, embedded_at\n    FROM kb_documents ORDER BY created_at DESC\n  ").all();
}
export function getDocument(id) {
    return db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(id);
}
export function deleteDocument(id) {
    db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(id);
    var result = db.prepare('DELETE FROM kb_documents WHERE id = ?').run(id);
    return result.changes > 0;
}
function updateDocumentStatus(id, status, extra) {
    var _a, _b, _c;
    db.prepare("\n    UPDATE kb_documents SET status = ?, chunk_count = COALESCE(?, chunk_count), error = ?, embedded_at = COALESCE(?, embedded_at)\n    WHERE id = ?\n  ").run(status, (_a = extra === null || extra === void 0 ? void 0 : extra.chunk_count) !== null && _a !== void 0 ? _a : null, (_b = extra === null || extra === void 0 ? void 0 : extra.error) !== null && _b !== void 0 ? _b : null, (_c = extra === null || extra === void 0 ? void 0 : extra.embedded_at) !== null && _c !== void 0 ? _c : null, id);
}
// ============= 文本切片 =============
export function chunkText(text, chunkSize, overlap) {
    var clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!clean)
        return [];
    if (clean.length <= chunkSize)
        return [clean];
    var chunks = [];
    var start = 0;
    while (start < clean.length) {
        var end = Math.min(start + chunkSize, clean.length);
        // 尝试在句子/段落边界处断开
        if (end < clean.length) {
            var window_1 = clean.slice(start, end);
            var breakPoints = ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', '；', '; '];
            var bestBreak = -1;
            for (var _i = 0, breakPoints_1 = breakPoints; _i < breakPoints_1.length; _i++) {
                var bp = breakPoints_1[_i];
                var idx = window_1.lastIndexOf(bp);
                if (idx > chunkSize * 0.5) {
                    bestBreak = idx + bp.length;
                    break;
                }
            }
            if (bestBreak > 0)
                end = start + bestBreak;
        }
        chunks.push(clean.slice(start, end).trim());
        if (end >= clean.length)
            break;
        start = Math.max(end - overlap, start + 1);
    }
    return chunks.filter(function (c) { return c.length > 0; });
}
// ============= Embedding =============
/**
 * 本地降级向量化（无需 API Key，开箱即用）：
 * 基于字符 n-gram 哈希的 512 维 TF 向量，L2 归一化。
 * 精度不如真实 Embedding 模型，但对中文文档检索有基本可用的效果。
 * 配置了 OpenAI 兼容 Embedding API 后会自动切换为 API 模式。
 */
var LOCAL_DIM = 512;
function localEmbed(text) {
    var vec = new Array(LOCAL_DIM).fill(0);
    var normalized = text.toLowerCase().replace(/\s+/g, ' ');
    // 中文按 2-gram，英文按词
    var grams = [];
    for (var i = 0; i < normalized.length - 1; i++) {
        grams.push(normalized.slice(i, i + 2));
    }
    var words = normalized.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(function (w) { return w.length > 1; });
    grams.push.apply(grams, words);
    for (var _i = 0, grams_1 = grams; _i < grams_1.length; _i++) {
        var g = grams_1[_i];
        var h = 2166136261;
        for (var i = 0; i < g.length; i++) {
            h ^= g.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        vec[Math.abs(h) % LOCAL_DIM] += 1;
    }
    // L2 归一化
    var norm = Math.sqrt(vec.reduce(function (s, v) { return s + v * v; }, 0)) || 1;
    return vec.map(function (v) { return v / norm; });
}
/** 调用 OpenAI 兼容 Embedding API（批量） */
function apiEmbed(texts, settings) {
    return __awaiter(this, void 0, void 0, function () {
        var url, endpoint, resp, body, data, sorted;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    url = settings.embeddingApiUrl.replace(/\/$/, '');
                    endpoint = url.endsWith('/embeddings') ? url : "".concat(url, "/embeddings");
                    return [4 /*yield*/, fetch(endpoint, {
                            method: 'POST',
                            headers: __assign({ 'Content-Type': 'application/json' }, (settings.embeddingApiKey ? { Authorization: "Bearer ".concat(settings.embeddingApiKey) } : {})),
                            body: JSON.stringify({ model: settings.embeddingModel, input: texts }),
                        })];
                case 1:
                    resp = _a.sent();
                    if (!!resp.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, resp.text()];
                case 2:
                    body = _a.sent();
                    throw new Error("Embedding API \u8C03\u7528\u5931\u8D25 (".concat(resp.status, "): ").concat(body.slice(0, 300)));
                case 3: return [4 /*yield*/, resp.json()];
                case 4:
                    data = _a.sent();
                    sorted = __spreadArray([], data.data, true).sort(function (a, b) { return a.index - b.index; });
                    return [2 /*return*/, sorted.map(function (d) { return d.embedding; })];
            }
        });
    });
}
/** 统一的向量化入口：配置了 API 则走 API，否则本地降级 */
export function embedTexts(texts) {
    return __awaiter(this, void 0, void 0, function () {
        var settings, BATCH, vectors, i, batch, _a, _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    settings = getSettings();
                    if (!settings.embeddingApiUrl) return [3 /*break*/, 5];
                    BATCH = 16;
                    vectors = [];
                    i = 0;
                    _d.label = 1;
                case 1:
                    if (!(i < texts.length)) return [3 /*break*/, 4];
                    batch = texts.slice(i, i + BATCH);
                    _b = (_a = vectors.push).apply;
                    _c = [vectors];
                    return [4 /*yield*/, apiEmbed(batch, settings)];
                case 2:
                    _b.apply(_a, _c.concat([_d.sent()]));
                    _d.label = 3;
                case 3:
                    i += BATCH;
                    return [3 /*break*/, 1];
                case 4: return [2 /*return*/, { vectors: vectors, mode: 'api' }];
                case 5: return [2 /*return*/, { vectors: texts.map(localEmbed), mode: 'local' }];
            }
        });
    });
}
/** 对指定文档执行切片 + 向量化 */
export function embedDocument(docId) {
    return __awaiter(this, void 0, void 0, function () {
        var doc, settings, chunks_1, _a, vectors_1, mode, del_1, ins_1, tx, e_1;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    doc = getDocument(docId);
                    if (!doc)
                        throw new Error('文档不存在');
                    updateDocumentStatus(docId, 'embedding');
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    settings = getSettings();
                    chunks_1 = chunkText(doc.content, settings.chunkSize, settings.chunkOverlap);
                    if (chunks_1.length === 0)
                        throw new Error('文档内容为空，无法向量化');
                    return [4 /*yield*/, embedTexts(chunks_1)];
                case 2:
                    _a = _b.sent(), vectors_1 = _a.vectors, mode = _a.mode;
                    del_1 = db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?');
                    ins_1 = db.prepare('INSERT INTO kb_chunks (id, doc_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, ?)');
                    tx = db.transaction(function () {
                        del_1.run(docId);
                        chunks_1.forEach(function (content, i) {
                            ins_1.run(uuidv4(), docId, i, content, JSON.stringify(vectors_1[i]));
                        });
                    });
                    tx();
                    updateDocumentStatus(docId, 'ready', { chunk_count: chunks_1.length, error: null, embedded_at: new Date().toISOString() });
                    return [2 /*return*/, { chunkCount: chunks_1.length, mode: mode }];
                case 3:
                    e_1 = _b.sent();
                    updateDocumentStatus(docId, 'error', { error: (e_1 === null || e_1 === void 0 ? void 0 : e_1.message) || String(e_1) });
                    throw e_1;
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ============= 相似度检索 =============
function cosine(a, b) {
    if (a.length !== b.length)
        return -1;
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    var denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}
/** 在所有已向量化(ready)的文档中检索与 query 最相关的切片 */
export function search(queryText, topK) {
    return __awaiter(this, void 0, void 0, function () {
        var settings, k, rows, vectors, qVec, scored, _i, rows_1, row, vec, score;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    settings = getSettings();
                    k = topK !== null && topK !== void 0 ? topK : settings.topK;
                    rows = db.prepare("\n    SELECT c.doc_id as docId, d.name as docName, c.chunk_index as chunkIndex, c.content, c.embedding\n    FROM kb_chunks c\n    JOIN kb_documents d ON d.id = c.doc_id\n    WHERE d.status = 'ready' AND c.embedding IS NOT NULL\n  ").all();
                    if (rows.length === 0)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, embedTexts([queryText])];
                case 1:
                    vectors = (_a.sent()).vectors;
                    qVec = vectors[0];
                    scored = [];
                    for (_i = 0, rows_1 = rows; _i < rows_1.length; _i++) {
                        row = rows_1[_i];
                        try {
                            vec = JSON.parse(row.embedding);
                            score = cosine(qVec, vec);
                            if (score > 0) {
                                scored.push({ docId: row.docId, docName: row.docName, chunkIndex: row.chunkIndex, content: row.content, score: score });
                            }
                        }
                        catch ( /* 跳过损坏数据 */_b) { /* 跳过损坏数据 */ }
                    }
                    scored.sort(function (a, b) { return b.score - a.score; });
                    return [2 /*return*/, scored.slice(0, k)];
            }
        });
    });
}
/** 构建注入了知识库上下文的系统提示词 */
export function buildRagSystemPrompt(results, customPrompt) {
    var settings = getSettings();
    var template = (customPrompt && customPrompt.trim()) || settings.ragPrompt || DEFAULT_RAG_PROMPT;
    var context = results.length > 0
        ? results.map(function (r, i) { return "[\u7247\u6BB5 ".concat(i + 1, "]\uFF08\u6765\u6E90\uFF1A").concat(r.docName, "\uFF0C\u76F8\u5173\u5EA6\uFF1A").concat((r.score * 100).toFixed(1), "%\uFF09\n").concat(r.content); }).join('\n\n---\n\n')
        : '（未检索到相关内容）';
    if (template.includes('{context}')) {
        return template.replace('{context}', context);
    }
    // 提示词中没写 {context} 占位符时，自动在末尾附加参考内容
    return "".concat(template, "\n\n\u3010\u77E5\u8BC6\u5E93\u53C2\u8003\u5185\u5BB9\u3011\n").concat(context);
}
/** 是否存在已就绪的知识库文档 */
export function hasReadyDocuments() {
    var row = db.prepare("SELECT COUNT(*) as cnt FROM kb_documents WHERE status = 'ready'").get();
    return row.cnt > 0;
}
