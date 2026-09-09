/**
 * 医疗导诊语料播种脚本（server/seed.ts）
 * ------------------------------------------------------------
 * 用途：把 server/corpus/ 下的医疗分诊演示语料（含章节元数据）
 *      一键灌入**真实知识库**（data/chat.db），让「智能导诊 / 知识库问答」
 *      开箱即可演示，无需手动逐个上传。
 *
 * 运行： npm run seed
 * 可选环境变量：
 *   SEED_FORCE=1   已存在的同名语料先删除再重建（默认跳过，保证幂等）
 *   SEED_LOCAL=1   强制使用本地 512 维向量（离线可跑，默认跟随全局 Embedding 配置）
 *
 * 说明：与评估脚本 eval.ts 不同 —— eval 走**隔离数据库**且跑完即清理，
 *      本脚本写入的是用户真实知识库，用于实际演示与二次开发。
 */
import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_DIR = path.join(__dirname, 'corpus');

async function main(): Promise<void> {
  // 可选：强制本地向量（离线环境友好）
  const forceLocal = process.env.SEED_LOCAL === '1';
  if (forceLocal) {
    process.env.EMBEDDING_API_URL = '';
    process.env.EMBEDDING_API_KEY = '';
  }

  const kb = await import('./kb.js');

  if (!fs.existsSync(CORPUS_DIR)) {
    throw new Error(`未找到语料目录: ${CORPUS_DIR}`);
  }
  const corpusFiles = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md')).sort();
  if (corpusFiles.length === 0) throw new Error(`语料目录为空: ${CORPUS_DIR}`);

  const existing = kb.getAllDocuments();
  const force = process.env.SEED_FORCE === '1';

  console.log('══════════ 医疗导诊语料播种 ══════════');
  console.log(`语料目录   : server/corpus/ (${corpusFiles.length} 篇)`);
  console.log(`目标知识库 : ${process.env.KB_DB_PATH || path.join(__dirname, '..', 'data', 'chat.db')}`);
  console.log(`模式       : ${force ? '强制重建（SEED_FORCE=1）' : '幂等增量（已存在则跳过）'}`);
  console.log('');

  let added = 0;
  let skipped = 0;
  let totalChunks = 0;
  let mode = '';

  for (const f of corpusFiles) {
    const dup = existing.find((d) => d.name === f);
    if (dup) {
      if (force) {
        await kb.deleteDocument(dup.id);
        console.log(`  ⟳ ${f}（已存在，强制重建）`);
      } else {
        skipped += 1;
        console.log(`  ⏭ ${f}（已存在，跳过；需重灌请用 SEED_FORCE=1）`);
        continue;
      }
    }
    const text = fs.readFileSync(path.join(CORPUS_DIR, f), 'utf8');
    const doc = kb.createDocument({
      name: f,
      ext: '.md',
      size: Buffer.byteLength(text, 'utf8'),
      content: text,
    });
    const res = await kb.embedDocument(doc.id);
    totalChunks += res.chunkCount;
    mode = res.mode;
    added += 1;
    console.log(`  ✓ ${f} → ${res.chunkCount} 个切片（${res.mode === 'api' ? 'Embedding API' : '本地向量'}）`);
  }

  const docs = kb.getAllDocuments();
  console.log('');
  console.log(`新增 ${added} 篇 / 跳过 ${skipped} 篇，共 ${totalChunks} 个切片` +
    (mode ? `（向量模式：${mode === 'api' ? 'Embedding API' : '本地 512 维'}）` : ''));
  console.log(`知识库现有 ${docs.length} 个文档`);
  console.log('');
  console.log('完成 ✅  现在可访问 http://localhost:3210 体验「智能导诊」。');
}

main().catch((e: any) => {
  console.error('播种失败:', e?.message ?? e);
  process.exitCode = 1;
});
