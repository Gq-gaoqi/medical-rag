/**
 * RAG 智能医疗导诊系统 · 检索评估基线（Recall@K）
 * ─────────────────────────────────────────────────────────────
 * 运行： npm run eval   （或 npx tsx server/eval.ts）
 *
 * 设计要点（面向作品集展示，强调「可复现 / 不污染真实库」）：
 *  1) 独立隔离数据库：评估走 KB_DB_PATH 指定的独立 db 文件，
 *     绝不触碰用户真实知识库（data/chat.db），且每次运行结果可复现。
 *  2) 本地降级向量化：评估强制走本地 512 维 Embedding，无需外部 API，
 *     一条命令即可跑出离线基线（如需评 API 向量化，设 EVAL_USE_API=1）。
 *  3) 医疗语料种子：从 server/corpus/ 读取演示用分诊文档（5 篇，含章节）。
 *  4) 标准 IR 指标：Recall@1 / Recall@3 / Recall@5（文档级命中）、
 *     事实覆盖率（Fact Coverage）、混合检索命中占比、以及可选 LLM 忠实度。
 *  5) 报告产物：控制台表格 + 自动生成 eval-report.md，方便直接截图进作品集。
 */

import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ① 隔离：评估使用独立 DB，绝不影响用户真实知识库
const EVAL_DB = path.join(__dirname, '..', 'data', 'eval-isolation.db');
process.env.KB_DB_PATH = EVAL_DB;

// ② 基线只评「检索阶段」：关闭 LLM 二阶段重排，Recall@K 直接度量
//    向量召回 + BM25(jieba) + FTS5 → RRF 融合的召回质量（离线、可复现）。
//    重排是 stage-2 增强，留待 P2 单独用 Cross-Encoder 做对照实验。
process.env.RERANK_ENABLED = 'false';

const CORPUS_DIR = path.join(__dirname, 'corpus');

// ============= 评估集（医疗导诊查询 + 应召回的黄金文档 + 关键事实） =============

interface EvalCase {
  query: string;
  /** 该 query「应当召回」的黄金文档文件名（文档级 Recall@K 判据） */
  goldDocs: string[];
  /** 应出现在 TopK 上下文中的关键事实（务必是语料中的精确子串） */
  expectFacts: string[];
}

const EVAL_CASES: EvalCase[] = [
  {
    query: '反复头痛还伴随恶心呕吐，应该挂哪个科？',
    goldDocs: ['01-内科常见症状分诊.md'],
    expectFacts: ['神经内科', '脑血管意外'],
  },
  {
    query: '胸口压榨样疼痛而且出冷汗，是不是心梗？去看什么科？',
    goldDocs: ['02-外科与急诊分诊.md'],
    expectFacts: ['急诊', '胸痛中心', '急性心梗'],
  },
  {
    query: '怀孕两个多月突然有点出血和肚子疼，情况紧急吗？',
    goldDocs: ['03-妇产科儿科分诊.md'],
    expectFacts: ['产科'],
  },
  {
    query: '我有高血压，平时一般吃哪种降压药？',
    goldDocs: ['04-慢性病用药管理.md'],
    expectFacts: ['氨氯地平', '缬沙坦', 'ACEI'],
  },
  {
    query: '家里老人突然一边手脚没力气、说话也大舌头了，怎么办？',
    goldDocs: ['05-急症识别与自救.md'],
    expectFacts: ['FAST', '120', '卒中中心'],
  },
  {
    query: '小朋友反复发烧还起了疹子，应该去哪看？',
    goldDocs: ['03-妇产科儿科分诊.md'],
    expectFacts: ['儿科', '急诊儿科'],
  },
  {
    query: '吃鱼不小心卡到刺了，是挂急诊还是耳鼻喉科？',
    goldDocs: ['02-外科与急诊分诊.md'],
    expectFacts: ['耳鼻喉科'],
  },
  {
    query: '长期拉肚子、下腹也经常痛，要不要看消化内科？',
    goldDocs: ['01-内科常见症状分诊.md'],
    expectFacts: ['消化内科', '便血'],
  },
];

// ============= 工具函数 =============

function factsCoverage(facts: string[], context: string): { covered: string[]; missed: string[] } {
  const covered: string[] = [];
  const missed: string[] = [];
  for (const f of facts) {
    if (context.includes(f)) covered.push(f);
    else missed.push(f);
  }
  return { covered, missed };
}

function parseYesNo(text: string): boolean | null {
  const t = ` ${text.trim().toUpperCase()} `;
  if (t.includes(' YES ')) return true;
  if (t.includes(' NO ')) return false;
  return null;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

// ============= 主流程 =============

interface CaseReport {
  query: string;
  hitAt: Record<number, boolean>;
  recall: number;
  covered: string[];
  missed: string[];
  sources: Record<string, number>;
  faithfulness: boolean | null;
  faithReason: string;
}

async function main(): Promise<void> {
  // 动态导入：须在后于 KB_DB_PATH 设置，确保 kb 模块连的是隔离 DB
  const kb = await import('./kb.js');
  const llm = await import('./llm.js');

  llm.updateLlmConfig({
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    openaiModel: process.env.OPENAI_MODEL,
    codebuddyApiKey: process.env.CODEBUDDY_API_KEY,
    codebuddyAuthToken: process.env.CODEBUDDY_AUTH_TOKEN,
  });

  const topK = Math.max(1, parseInt(process.env.EVAL_TOPK ?? '5', 10));
  const useApi = process.env.EVAL_USE_API === '1';
  const keep = process.env.EVAL_KEEP === '1';

  // 强制本地向量化以获得可复现的离线基线（除非显式要求 API 模式）
  if (!useApi) {
    kb.saveSettings({ embeddingApiUrl: '', embeddingApiKey: '' });
  }

  if (!fs.existsSync(CORPUS_DIR)) {
    throw new Error(`未找到语料目录: ${CORPUS_DIR}（请将医疗分诊语料放在 server/corpus/ 下）`);
  }
  const corpusFiles = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md'));
  if (corpusFiles.length === 0) throw new Error(`语料目录为空: ${CORPUS_DIR}`);

  const ingestedIds: string[] = [];
  console.log('══════════════ RAG 智能医疗导诊系统 · 检索评估基线 ════════════════');
  console.log(`语料来源   : server/corpus/ (${corpusFiles.length} 篇演示分诊文档)`);
  console.log(`向量化模式 : ${useApi ? 'API (text-embedding-v3)' : '本地降级 (512 维, 无需 API Key)'}`);
  console.log(`检索链路   : 混合检索 = 向量召回 + BM25(jieba) + FTS5, RRF 融合（基线关闭 LLM 重排，纯检索阶段度量）`);
  const llmReady = llm.isLlmConfigured();
  const faithMode = process.env.EVAL_FAITH === '1';
  console.log(`LLM 裁判   : ${llmReady ? (faithMode ? '已配置 ✅（将评估 faithfulness）' : '已配置 ✅（基线关闭，设 EVAL_FAITH=1 开启忠实度）') : '未配置 ⚠️（faithfulness 跳过）'}`);
  console.log(`评估样本   : ${EVAL_CASES.length} 条导诊查询, 取 Top${topK}`);

  try {
    // 1) 播种医疗语料
    console.log(`\n[1/4] 载入医疗语料（${corpusFiles.length} 篇）...`);
    let totalChunks = 0;
    for (const f of corpusFiles) {
      const text = fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8');
      const doc = kb.createDocument({ name: f, ext: '.md', size: Buffer.byteLength(text, 'utf8'), content: text });
      const { chunkCount, mode } = await kb.embedDocument(doc.id);
      void mode;
      totalChunks += chunkCount;
      ingestedIds.push(doc.id);
    }
    const docs = kb.getAllDocuments();
    console.log(`       ✓ 已向量化 ${docs.length} 篇 / ${totalChunks} 个切片（评估后自动清理）`);

    // 2) 逐条评估
    console.log(`\n[2/4] 逐条评估（Recall@K + 事实覆盖${faithMode ? ' + 忠实度' : ''}）...`);
    const reports: CaseReport[] = [];
    for (let i = 0; i < EVAL_CASES.length; i++) {
      const c = EVAL_CASES[i];
      const results = await kb.search(c.query, topK);
      const docNames = results.map((r) => r.docName);

      const hitAt: Record<number, boolean> = { 1: false, 3: false, 5: false };
      for (const k of [1, 3, 5]) {
        hitAt[k] = results.slice(0, k).some((r) => c.goldDocs.includes(r.docName));
      }
      const recall = c.goldDocs.some((g) => docNames.includes(g)) ? 1 : 0;

      const context = results.map((r) => r.content).join('\n');
      const { covered, missed } = factsCoverage(c.expectFacts, context);

      const sources: Record<string, number> = {};
      for (const r of results) {
        const s = r.source ?? 'unknown';
        sources[s] = (sources[s] ?? 0) + 1;
      }

      let faithfulness: boolean | null = null;
      let faithReason = llmReady ? '(未执行)' : '(LLM 未配置，跳过)';
      // 忠实度评估默认关闭（需联网调 LLM），EVAL_FAITH=1 时显式开启
      if (process.env.EVAL_FAITH === '1' && llmReady && results.length > 0) {
        try {
          const answer = await llm.complete({ prompt: c.query, systemPrompt: kb.buildRagSystemPrompt(results), temperature: 0 });
          const judgeRaw = await llm.complete({
            systemPrompt: '你是客观的评测裁判。判断【回答】是否完全由【上下文】支撑、没有编造事实。只回答 YES 或 NO，并在同一行给一句简短理由。',
            prompt: `【上下文】\n${context}\n\n【回答】\n${answer}\n\n判定(YES/NO)：`,
            temperature: 0,
          });
          const yes = parseYesNo(judgeRaw);
          faithfulness = yes;
          faithReason = yes === null ? `(裁判输出无法解析: ${judgeRaw.trim().slice(0, 60)})` : judgeRaw.trim().slice(0, 80);
        } catch (e: any) {
          faithReason = `(LLM 调用失败: ${String(e?.message ?? e).slice(0, 60)})`;
        }
      }

      reports.push({ query: c.query, hitAt, recall, covered, missed, sources, faithfulness, faithReason });
      const faithStr = !faithMode ? '—' : faithfulness === null ? (llmReady ? '调用失败' : '—') : faithfulness ? '忠实' : '有编造';
      console.log(
        `  [${i + 1}] @1=${hitAt[1] ? '✓' : '✗'} @3=${hitAt[3] ? '✓' : '✗'} @5=${hitAt[5] ? '✓' : '✗'}  ` +
          `事实=${covered.length}/${c.expectFacts.length}  来源=${JSON.stringify(sources)}  faith=${faithStr}`,
      );
      if (missed.length) console.log(`       未命中事实: ${missed.join(' / ')}`);
    }

    // 3) 汇总指标
    console.log(`\n[3/4] 汇总（Recall@K 文档级命中率）`);
    const ks = [1, 3, 5];
    const recallAt: Record<number, number> = { 1: 0, 3: 0, 5: 0 };
    for (const k of ks) recallAt[k] = reports.filter((r) => r.hitAt[k]).length / reports.length;

    const meanFact = reports.reduce((s, r) => s + r.covered.length / Math.max(1, EVAL_CASES.find((c) => c.query === r.query)!.expectFacts.length), 0) / reports.length;

    // 混合检索命中占比：Top 结果中 source=hybrid 的比例
    let hybridHits = 0;
    let totalHits = 0;
    for (const r of reports) {
      for (const [s, n] of Object.entries(r.sources)) {
        totalHits += n;
        if (s === 'hybrid') hybridHits += n;
      }
    }
    const hybridRatio = totalHits ? hybridHits / totalHits : 0;

    const judged = reports.filter((r) => r.faithfulness !== null);
    const faithful = judged.filter((r) => r.faithfulness === true);
    const meanFaith = judged.length ? faithful.length / judged.length : null;

    console.log('  ┌────────────────────────────────────────────────────────');
    console.log(`  │ Recall@1 = ${fmtPct(recallAt[1])}    Recall@3 = ${fmtPct(recallAt[3])}    Recall@5 = ${fmtPct(recallAt[5])}`);
    console.log(`  │ Fact Coverage（事实覆盖率） = ${fmtPct(meanFact)}`);
    console.log(`  │ 混合检索命中占比（RRF 融合生效） = ${fmtPct(hybridRatio)}`);
    const faithSummary = meanFaith !== null
      ? `${fmtPct(meanFaith)} (${faithful.length}/${judged.length})`
      : process.env.EVAL_FAITH === '1'
        ? (llmReady ? '0 条可用（调用失败）' : '跳过（未配置 LLM）')
        : '未评估（基线模式，设 EVAL_FAITH=1 开启）';
    console.log(`  │ Faithfulness（生成忠实度） = ${faithSummary}`);
    console.log('  └────────────────────────────────────────────────────────');
    console.log('\n  结论:');
    if (recallAt[5] >= 0.9) console.log('    ✅ 离线基线下检索召回良好，目标文档基本都能进入 Top5 上下文。');
    else if (recallAt[5] >= 0.6) console.log('    ⚠️ 检索召回一般，建议接入 API Embedding / 调大召回池 / 增强医疗同义词。');
    else console.log('    ❌ 检索召回偏低，需排查切片 / 向量维度 / 混合权重。');
    if (meanFaith !== null) {
      if (meanFaith >= 0.9) console.log('    ✅ 生成忠实度高，回答基本由上下文支撑、无编造。');
      else console.log('    ⚠️ 存在编造/偏离上下文的回答，需收紧提示词或加强重排。');
    } else {
      console.log('    ℹ️ 忠实度评估默认关闭（基线离线跑）。需联网对照时设 EVAL_FAITH=1 重跑。');
    }

    // 4) 生成报告文件（作品集可直接引用）
    const reportMd = buildReport({
      corpusCount: corpusFiles.length,
      chunkCount: totalChunks,
      topK,
      useApi,
      recallAt,
      meanFact,
      hybridRatio,
      meanFaith,
      judgedCount: judged.length,
      faithfulCount: faithful.length,
      reports,
    });
    const reportPath = path.join(__dirname, '..', 'eval-report.md');
    fs.writeFileSync(reportPath, reportMd, 'utf8');
    console.log(`\n[4/4] 评估报告已生成: ${reportPath}`);

    // 5) 清理
    console.log(`\n[清理] 移除评估语料...`);
    if (keep) {
      console.log('      ⚠️ EVAL_KEEP=1，已保留评估语料（隔离 DB: ' + EVAL_DB + '）');
    } else {
      for (const id of ingestedIds) {
        try { await kb.deleteDocument(id); } catch { /* ignore */ }
      }
      console.log(`      ✓ 已清理 ${ingestedIds.length} 篇评估语料`);
    }
  } catch (e: any) {
    for (const id of ingestedIds) {
      try { await kb.deleteDocument(id); } catch { /* ignore */ }
    }
    console.error('\n评估中断:', e?.message ?? e);
    process.exitCode = 1;
  }
}

function buildReport(args: {
  corpusCount: number;
  chunkCount: number;
  topK: number;
  useApi: boolean;
  recallAt: Record<number, number>;
  meanFact: number;
  hybridRatio: number;
  meanFaith: number | null;
  judgedCount: number;
  faithfulCount: number;
  reports: CaseReport[];
}): string {
  const { corpusCount, chunkCount, topK, useApi, recallAt, meanFact, hybridRatio, meanFaith, judgedCount, faithfulCount, reports } = args;
  const lines: string[] = [];
  lines.push('# RAG 智能医疗导诊系统 · 检索评估报告');
  lines.push('');
  lines.push(`> 自动生成于 \`npm run eval\`，评估库与用户真实知识库物理隔离，可一键复现。`);
  lines.push('');
  lines.push('## 一、配置与语料');
  lines.push('');
  lines.push(`- **向量化模式**：${useApi ? 'API (text-embedding-v3, 1024 维)' : '本地降级 (FNV-1a 哈希, 512 维, 无需 API Key)'}`);
  lines.push(`- **检索链路**：混合检索 = 向量召回 + BM25(jieba 分词) + FTS5 冗余兜底，RRF 融合 → 二阶段重排 → Top${topK}`);
  lines.push(`- **医疗语料**：server/corpus/ 下 ${corpusCount} 篇演示分诊文档，共 ${chunkCount} 个切片（含章节元数据）`);
  lines.push(`- **评估样本**：${reports.length} 条导诊查询`);
  lines.push('');
  lines.push('## 二、核心指标（IR 标准）');
  lines.push('');
  lines.push('| 指标 | 数值 | 说明 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Recall@1 | **${fmtPct(recallAt[1])}** | 第 1 条命中黄金文档的查询占比 |`);
  lines.push(`| Recall@3 | **${fmtPct(recallAt[3])}** | Top3 命中黄金文档的查询占比 |`);
  lines.push(`| Recall@5 | **${fmtPct(recallAt[5])}** | Top5 命中黄金文档的查询占比 |`);
  lines.push(`| Fact Coverage | **${fmtPct(meanFact)}** | 关键事实进入上下文的覆盖率 |`);
  lines.push(`| 混合检索命中占比 | **${fmtPct(hybridRatio)}** | 命中结果经 RRF 融合（向量+关键词共同贡献）的比例 |`);
  const faithStr = meanFaith !== null
    ? `${fmtPct(meanFaith)} (${faithfulCount}/${judgedCount})`
    : (process.env.EVAL_FAITH === '1'
      ? (judgedCount > 0 ? '调用失败' : '未配置 LLM')
      : '未评估（基线模式，EVAL_FAITH=1 开启）');
  lines.push(`| Faithfulness | **${faithStr}** | 生成回答由上下文支撑、无编造的比例（需 LLM 裁判） |`);
  lines.push('');
  lines.push('## 三、逐条明细');
  lines.push('');
  lines.push('| # | 查询 | @1 | @3 | @5 | 事实覆盖 | 检索来源 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  reports.forEach((r, i) => {
    const src = Object.entries(r.sources).map(([s, n]) => `${s}:${n}`).join(' ');
    const fact = `${r.covered.length}/${EVAL_CASES[i].expectFacts.length}`;
    lines.push(`| ${i + 1} | ${r.query} | ${r.hitAt[1] ? '✓' : '✗'} | ${r.hitAt[3] ? '✓' : '✗'} | ${r.hitAt[5] ? '✓' : '✗'} | ${fact} | ${src} |`);
  });
  lines.push('');
  lines.push('## 四、结论');
  lines.push('');
  if (recallAt[5] >= 0.9) lines.push('- ✅ 离线基线下检索召回良好，目标文档基本都能进入 Top5 上下文，混合检索（向量 + BM25）协同生效。');
  else if (recallAt[5] >= 0.6) lines.push('- ⚠️ 检索召回一般，建议接入 API Embedding / 调大召回池 / 增强医疗同义词，Recall@K 可作后续迭代的量化对照。');
  else lines.push('- ❌ 检索召回偏低，需排查切片 / 向量维度 / 混合权重。');
  if (meanFaith !== null) {
    if (meanFaith >= 0.9) lines.push('- ✅ 生成忠实度高，回答基本由上下文支撑、无编造。');
    else lines.push('- ⚠️ 存在编造/偏离上下文的回答，需收紧提示词或加强重排。');
  } else {
    lines.push('- ℹ️ 检索忠实度（Faithfulness）评估默认关闭（基线离线跑）；需联网对照时设 `EVAL_FAITH=1` 重跑。');
  }
  lines.push('');
  return lines.join('\n');
}

main();
