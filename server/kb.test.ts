/**
 * 知识库核心逻辑单元测试（纯函数，无网络/无外部依赖）
 * 运行：npx tsx server/kb.test.ts   （或 npm test）
 *
 * 通过 KB_DB_PATH 指向临时库，避免污染真实数据。
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import assert from 'assert';

const tmpDb = path.join(os.tmpdir(), `kb-test-${Date.now()}.db`);
process.env.KB_DB_PATH = tmpDb;

const kb = await import('./kb.js');

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e?.message ?? e}`);
  }
}

/** 异步用例：会 await 断言结果，避免 async 抛错变成未捕获 rejection */
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e: any) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e?.message ?? e}`);
  }
}

function cleanup() {
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

console.log('\n[chunkText]');
check('空/空白文本返回空数组', () => {
  assert.deepStrictEqual(kb.chunkText('', 800, 100), []);
  assert.deepStrictEqual(kb.chunkText('   \n\n  ', 800, 100), []);
});
check('短文本不超过 chunkSize 时原样返回', () => {
  const t = '这是一段很短的文本内容。';
  const out = kb.chunkText(t, 800, 100);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0], t);
});
check('长文本被切成多个非空片段', () => {
  const para = '知识库是用于存储和管理个人资料的系统。';
  const text = para.repeat(200); // 远超 chunkSize
  const out = kb.chunkText(text, 800, 100);
  assert.ok(out.length > 1, `应切分为多段，实际 ${out.length} 段`);
  assert.ok(out.every(c => c.length > 0), '不应有空片段');
  // 所有片段长度都应 <= chunkSize（边界断开后会略小，但绝不应超过 chunkSize 太多）
  assert.ok(out.every(c => c.length <= 800 + 50), '单片段不应超过 chunkSize 过多');
});
check('重叠参数不会产生无限循环（长无标点文本）', () => {
  const text = 'x'.repeat(5000);
  const out = kb.chunkText(text, 800, 100);
  assert.ok(out.length >= 5);
  assert.ok(out.every(c => c.length > 0));
});

console.log('\n[cosine]');
check('相同向量相似度为 1', () => {
  const v = [0.1, 0.2, -0.3, 0.4];
  assert.ok(Math.abs(kb.cosine(v, v) - 1) < 1e-9);
});
check('正交向量相似度为 0', () => {
  assert.ok(Math.abs(kb.cosine([1, 0], [0, 1])) < 1e-9);
});
check('零向量返回 0（避免除零）', () => {
  assert.strictEqual(kb.cosine([0, 0, 0], [1, 2, 3]), 0);
});
check('长度不一致返回 -1', () => {
  assert.strictEqual(kb.cosine([1, 2], [1, 2, 3]), -1);
});

console.log('\n[rankSearchResults]');
check('按相似度降序并返回 topK', () => {
  // 构造 3 个向量：qVec 与 v0 高相关、v1 中相关、v2 不相关(正交)
  const qVec = [1, 0, 0];
  const rows = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: 'a0', embedding: JSON.stringify([0, 1, 0]) }, // 0
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: 'b0', embedding: JSON.stringify([1, 0, 0]) }, // 1
    { docId: 'd3', docName: 'C', chunkIndex: 0, content: 'c0', embedding: JSON.stringify([0.9, 0, 0]) }, // 0.9
  ];
  const res = kb.rankSearchResults(rows, qVec, 2);
  assert.strictEqual(res.length, 2);
  assert.strictEqual(res[0].docId, 'd2'); // 1.0
  assert.strictEqual(res[1].docId, 'd3'); // 0.9
});
check('过滤掉相似度 <= 0 的结果', () => {
  const qVec = [1, 0];
  const rows = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: 'a', embedding: JSON.stringify([1, 0]) },
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: 'b', embedding: JSON.stringify([0, 1]) }, // 0
  ];
  const res = kb.rankSearchResults(rows, qVec, 10);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].docId, 'd1');
});
check('跳过损坏的 embedding JSON 而不崩溃', () => {
  const qVec = [1, 0];
  const rows = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: 'a', embedding: 'not-json' },
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: 'b', embedding: JSON.stringify([1, 0]) },
  ];
  const res = kb.rankSearchResults(rows, qVec, 10);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].docId, 'd2');
});

console.log('\n[buildRagSystemPrompt]');
check('无检索结果时包含占位提示', () => {
  const p = kb.buildRagSystemPrompt([]);
  assert.ok(p.includes('未检索到相关内容'), '应提示未检索到内容');
});
check('有结果时注入片段内容', () => {
  const p = kb.buildRagSystemPrompt([
    { docId: 'd1', docName: '手册.pdf', chunkIndex: 0, content: '本地备份策略应当每日执行。', score: 0.92 },
  ]);
  assert.ok(p.includes('手册.pdf'), '应出现文档名');
  assert.ok(p.includes('本地备份策略应当每日执行。'), '应出现片段正文');
});
check('自定义提示词替换 {context} 占位符', () => {
  const p = kb.buildRagSystemPrompt([], '自定义模板，上下文如下：{context}');
  assert.ok(p.includes('自定义模板'), '应使用自定义模板');
  assert.ok(p.includes('未检索到相关内容'), '上下文应被替换');
});
check('自定义提示词无占位符时自动追加参考内容', () => {
  const p = kb.buildRagSystemPrompt(
    [{ docId: 'd1', docName: 'X', chunkIndex: 0, content: '你好世界', score: 0.5 }],
    '只用下面的资料回答：'
  );
  assert.ok(p.includes('你好世界'), '应自动追加片段');
});

console.log('\n[vectorStore / hybrid search]');
const vs = await import('./vectorStore.js');
const dbm = await import('./db.js');
const store = vs.getVectorStore();
check('默认向量存储为 sqlite 且支持关键词', () => {
  assert.strictEqual(store.name, 'sqlite');
  assert.strictEqual(store.supportsKeyword, true);
});

// 端到端：插入 ready 文档 + 切片，验证向量检索 / 关键词检索 / RRF 融合
await (async () => {
  const dim = 64;
  const mkVec = (seed: number) => Array.from({ length: dim }, (_, i) => Math.sin(seed * 10 + i));
  const v0 = mkVec(1);
  const v1 = mkVec(2);
  dbm.default.prepare(
    'INSERT OR IGNORE INTO kb_documents (id,name,ext,size,content,status,chunk_count,created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run('doc_h1', '手册.pdf', 'pdf', 10, 'x', 'ready', 2, new Date().toISOString());
  await store.upsertDocument('doc_h1', '手册.pdf', '1', [
    { chunkIndex: 0, content: '知识库检索系统支持中文子串匹配与混合检索', vector: v0 },
    { chunkIndex: 1, content: '完全无关的随机噪声内容 qwerty', vector: v1 },
  ]);

  const vecHits = await store.searchVector(v0, 4);
  check('向量检索召回最相似切片', () => {
    assert.ok(vecHits.some((h) => h.docId === 'doc_h1' && h.chunkIndex === 0), '应命中 chunk0');
    assert.strictEqual(vecHits[0].source, 'vector');
  });

  const kwHits = store.searchKeyword ? await store.searchKeyword('知识库检索系统', 4) : [];
  check('关键词检索(FTS5 trigram)命中相关切片', () => {
    assert.ok(kwHits.some((h) => h.docId === 'doc_h1' && h.chunkIndex === 0), '应命中 chunk0');
    assert.strictEqual(kwHits[0].source, 'keyword');
  });

  const fused = vs.reciprocalRankFusion([vecHits, kwHits], 4);
  check('RRF 融合后相关切片排第一且标记为 hybrid', () => {
    assert.strictEqual(fused[0].docId, 'doc_h1');
    assert.strictEqual(fused[0].chunkIndex, 0);
    assert.strictEqual(fused[0].source, 'hybrid');
  });

  // 清理本测试写入的数据
  await store.deleteDocument('doc_h1');
  dbm.default.prepare('DELETE FROM kb_documents WHERE id = ?').run('doc_h1');
})();

console.log('\n[rerank / 二阶段 LLM 重排]');
console.log('[bm25 / jieba + BM25 关键词索引]');
const bm = await import('./bm25.js');
{
  const idx = new bm.Bm25Index();
  idx.rebuild([
    { chunkId: 'd1#0', docId: 'd1', docName: '高血压指南', chunkIndex: 0, content: '高血压患者应长期规律服用降压药物，如氨氯地平、缬沙坦', chapter: '用药' },
    { chunkId: 'd2#0', docId: 'd2', docName: '糖尿病指南', chunkIndex: 0, content: '糖尿病患者需控制血糖，使用胰岛素或二甲双胍', chapter: '用药' },
    { chunkId: 'd3#0', docId: 'd3', docName: '感冒指南', chunkIndex: 0, content: '普通感冒多为病毒引起，注意休息与饮水', chapter: '概述' },
  ]);
  check('BM25 用高血压 吃什么药 命中高血压用药片段', () => {
    const r = idx.search('高血压 吃什么药', 2);
    assert.ok(r.length > 0 && r[0].docId === 'd1', '应首位命中 d1，实际 ' + JSON.stringify(r.map((x: any) => x.docId)));
  });
  check('BM25 用降压药 召回高血压文档(子词命中)', () => {
    const r = idx.search('降压药', 2);
    assert.ok(r.some((h: any) => h.docId === 'd1'), '应命中 d1');
  });
  check('BM25 不相关查询不命中高血压、命中感冒', () => {
    const r = idx.search('感冒 发烧 注意什么', 3);
    assert.ok(!r.some((h: any) => h.docId === 'd1'), '不应命中 d1');
    assert.ok(r.some((h: any) => h.docId === 'd3'), '应命中 d3');
  });
  check('BM25 元数据透传(章节/文档名)', () => {
    const r = idx.search('高血压 用药', 1);
    assert.strictEqual(r[0].docName, '高血压指南');
    assert.strictEqual(r[0].chapter, '用药');
    assert.strictEqual(r[0].source, 'keyword');
  });
}

const rr = await import('./rerank.js');

check('localRerank 把高度相关片段排到前面', () => {
  const cands = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: '完全无关的随机噪声内容 qwerty', score: 0.1 },
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: '知识库检索系统支持中文子串匹配与混合检索', score: 0.1 },
  ];
  const out = rr.localRerank('知识库检索系统', cands as any);
  assert.strictEqual(out[0].docId, 'd2');
  assert.ok(out[0].score > out[1].score);
});

await checkAsync('rerankWithLLM 按模型打分重排（mock complete）', async () => {
  const cands = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: '无关噪声内容 qwerty', score: 0.5 },
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: '知识库检索系统支持中文子串匹配', score: 0.5 },
  ];
  // 模型判定 d1 更相关(8 分)、d2 较弱(2 分)——模拟 LLM 纠正了 stage-1 顺序
  const mockComplete = async () =>
    JSON.stringify([{ index: 0, score: 8 }, { index: 1, score: 2 }]);
  const out = await rr.rerankWithLLM('知识库检索', cands as any, {
    topN: 2,
    complete: mockComplete as any,
  });
  assert.ok(out, '应返回结果');
  assert.strictEqual(out![0].docId, 'd1');
  assert.ok(out![0].score > out![1].score);
});

await checkAsync('rerankWithLLM 解析容错：模型夹带 ```json 代码块也能解析', async () => {
  const cands = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: 'x', score: 0.5 },
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: 'y', score: 0.5 },
  ];
  const mockComplete = async () =>
    '好的，结果如下：\n```json\n[{"index":0,"score":9},{"index":1,"score":1}]\n```\n以上。';
  const out = await rr.rerankWithLLM('q', cands as any, {
    topN: 2,
    complete: mockComplete as any,
  });
  assert.ok(out);
  assert.strictEqual(out![0].docId, 'd1');
});

await checkAsync('rerank 编排在 LLM 抛错时降级为 stage-1 顺序', async () => {
  const cands = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: 'alpha', score: 0.9 },
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: 'beta', score: 0.3 },
  ];
  const mockComplete = async () => { throw new Error('network down'); };
  const out = await rr.rerank('query', cands as any, {
    topN: 2,
    useLLM: true,
    complete: mockComplete as any,
  });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].docId, 'd1'); // stage-1 降序保持
  assert.strictEqual(out[1].docId, 'd2');
});

await checkAsync('rerank useLLM=false 时直接截断 stage-1 顺序', async () => {
  const cands = [
    { docId: 'd1', docName: 'A', chunkIndex: 0, content: 'a', score: 0.9 },
    { docId: 'd2', docName: 'B', chunkIndex: 0, content: 'b', score: 0.5 },
    { docId: 'd3', docName: 'C', chunkIndex: 0, content: 'c', score: 0.2 },
  ];
  const out = await rr.rerank('query', cands as any, { topN: 2, useLLM: false });
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].docId, 'd1');
  assert.strictEqual(out[1].docId, 'd2');
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
cleanup();
if (failed > 0) process.exit(1);
