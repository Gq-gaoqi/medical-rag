import "dotenv/config";
import express from "express";
import { unstable_v2_authenticate, PermissionResult, CanUseTool } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import multer from "multer";
import * as db from "./db.js";
import * as kb from "./kb.js";
import { triage } from "./triage.js";
import { logger } from "./logger.js";
import { dbPath } from "./db.js";
import * as llm from "./llm.js";

const execAsync = promisify(exec);

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

// 权限请求超时时间（5分钟）
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3210;

// Middleware
app.use(express.json());

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = "claude-sonnet-4";

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 登录方式类型
type LoginMethod = 'env' | 'cli' | 'none';

interface LoginStatusResponse {
  isLoggedIn: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string; // 脱敏后的 API Key
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
}

// 检查 CodeBuddy CLI 登录状态
app.get("/api/check-login", async (req, res) => {
  // 短路：当前 LLM provider 不是 CodeBuddy 时，跳过 CLI 登录检查
  // ——unstable_v2_authenticate() 在未登录时会阻塞等待用户在浏览器完成 OAuth，
  // 对 OpenAI 兼容模式用户毫无意义且会让接口 hang 到 SDK 超时。
  const currentProvider = llm.getLlmConfig().provider;
  if (currentProvider !== 'codebuddy') {
    return res.json({
      isLoggedIn: false,
      envConfigured: false,
      cliConfigured: false,
      method: 'none' as LoginMethod,
    });
  }

  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };
  
  // 1. 检查环境变量
  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;
  
  if (apiKey || authToken) {
    response.envConfigured = true;
    // 脱敏显示
    if (apiKey) {
      response.envVars!.apiKey = apiKey.slice(0, 8) + '****' + apiKey.slice(-4);
      response.apiKey = response.envVars!.apiKey;
    }
    if (authToken) {
      response.envVars!.authToken = authToken.slice(0, 8) + '****' + authToken.slice(-4);
    }
    if (internetEnv) {
      response.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      response.envVars!.baseUrl = baseUrl;
    }
  }
  
  // 2. 使用 unstable_v2_authenticate 检查登录状态（更可靠）
  try {
    let needsLogin = false;
    
    const result = await unstable_v2_authenticate({
      environment: 'external',
      onAuthUrl: async (authState) => {
        // 如果执行到这个回调，说明未登录
        needsLogin = true;
        console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
        // 将认证 URL 返回给前端（如果需要）
        response.error = '未登录，请先登录 CodeBuddy CLI';
      }
    });
    
    // 如果没有触发 onAuthUrl 回调，说明已登录
    if (!needsLogin && result?.userinfo) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      
      // 判断登录方式
      if (response.envConfigured) {
        response.method = 'env';
      } else {
        response.method = 'cli';
      }
      
      console.log('[Check Login] 已登录用户:', result.userinfo.userName);
    } else if (!needsLogin) {
      // result 存在但没有 userinfo，仍然认为已登录
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    console.error("[Check Login] SDK Error:", error);
    
    // 如果有环境变量配置，仍然认为是登录状态
    if (response.envConfigured) {
      response.isLoggedIn = true;
      response.method = 'env';
    } else {
      response.error = error?.message || String(error);
      response.method = 'none';
    }
  }
  
  res.json(response);
});

// 保存环境变量配置
app.post("/api/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;
  
  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }
  
  const configuredVars: string[] = [];
  
  // 设置环境变量（仅在当前进程有效）
  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }
  
  // 清除模型缓存，以便重新获取
  cachedModels = [];
  
  res.json({ 
    success: true, 
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// ─── LLM 提供商配置 ──────────────────────────────────────

/** 获取当前 LLM 提供商配置 */
app.get("/api/llm-config", (_req, res) => {
  const config = llm.getLlmConfig();
  // 脱敏 API Key
  const safe: Record<string, unknown> = { ...config };
  if (safe.codebuddyApiKey)
    safe.codebuddyApiKey = String(safe.codebuddyApiKey).slice(0, 8) + "****" + String(safe.codebuddyApiKey).slice(-4);
  if (safe.openaiApiKey)
    safe.openaiApiKey = String(safe.openaiApiKey).slice(0, 8) + "****" + String(safe.openaiApiKey).slice(-4);
  res.json(safe);
});

/** 更新 LLM 提供商配置（运行时生效） */
app.post("/api/llm-config", (req, res) => {
  try {
    const { provider, codebuddyApiKey, codebuddyAuthToken, codebuddyBaseUrl,
            openaiApiKey, openaiBaseUrl, openaiModel } = req.body;

    // 如果切换到 openai-compat，至少需要 apiKey 或 baseUrl
    if (provider === "openai-compat" && !openaiApiKey && !process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OpenAI 兼容模式需要配置 API Key" });
    }

    const updated = llm.updateLlmConfig({
      ...(provider ? { provider } : {}),
      ...(codebuddyApiKey !== undefined ? { codebuddyApiKey } : {}),
      ...(codebuddyAuthToken !== undefined ? { codebuddyAuthToken } : {}),
      ...(codebuddyBaseUrl !== undefined ? { codebuddyBaseUrl } : {}),
      ...(openaiApiKey !== undefined ? { openaiApiKey } : {}),
      ...(openaiBaseUrl !== undefined ? { openaiBaseUrl } : {}),
      ...(openaiModel !== undefined ? { openaiModel } : {}),
    });

    // 同步写入 CodeBuddy 环境变量（保持向后兼容）
    if (updated.codebuddyApiKey) process.env.CODEBUDDY_API_KEY = updated.codebuddyApiKey;
    if (updated.codebuddyAuthToken) process.env.CODEBUDDY_AUTH_TOKEN = updated.codebuddyAuthToken;
    if (updated.codebuddyBaseUrl) process.env.CODEBUDDY_BASE_URL = updated.codebuddyBaseUrl;
    if (updated.openaiApiKey) process.env.OPENAI_API_KEY = updated.openaiApiKey;
    if (updated.openaiBaseUrl) process.env.OPENAI_BASE_URL = updated.openaiBaseUrl;
    if (updated.openaiModel) process.env.OPENAI_MODEL = updated.openaiModel;

    cachedModels = []; // 清缓存，下次获取模型列表时刷新

    res.json({ success: true, config: updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "更新失败" });
  }
});

// 获取可用模型列表（根据当前 provider 自动分发）
app.get("/api/models", async (req, res) => {
  try {
    if (cachedModels.length === 0) {
      console.log("[Models] Fetching models for provider:", llm.getLlmConfig().provider);
      cachedModels = await llm.fetchAvailableModels();
    }

    // 确保至少有一个默认模型
    const fallback = llm.getLlmConfig().provider === "openai-compat"
      ? { modelId: "gpt-4o-mini", name: "GPT-4o Mini" }
      : { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" };

    res.json({
      models: cachedModels.length > 0 ? cachedModels : [fallback],
      defaultModel,
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel,
      error: error?.message || String(error)
    });
  }
});

// ============= 会话 API =============

// 获取所有会话（包含消息数量）
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 获取单个会话及其消息
app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    const messages = db.getMessagesBySession(sessionId);
    
    // 解析 tool_calls / kb_sources JSON
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null,
      kb_sources: msg.kb_sources ? JSON.parse(msg.kb_sources) : null
    }));
    
    res.json({ session, messages: parsedMessages });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 创建新会话
app.post("/api/sessions", (req, res) => {
  try {
    const { model = defaultModel, title = "新对话" } = req.body;
    const now = new Date().toISOString();
    
    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
      sdk_session_id: null,
      created_at: now,
      updated_at: now
    });
    
    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

// 更新会话
app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model } = req.body;
    
    const success = db.updateSession(sessionId, { title, model });
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

// 删除会话
app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = db.deleteSession(sessionId);
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// 删除单条消息
app.delete("/api/messages/:id", (req, res) => {
  try {
    const success = db.deleteMessage(req.params.id);
    if (!success) return res.status(404).json({ error: "消息不存在" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "删除消息失败" });
  }
});

// 跨会话搜索历史消息
app.get("/api/search", (req, res) => {
  try {
    const q = req.query.q;
    if (!q || typeof q !== 'string' || !q.trim()) {
      return res.status(400).json({ error: "缺少查询参数" });
    }
    const results = db.searchMessages(q);
    res.json({ results });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "搜索失败" });
  }
});

// ============= 知识库 API =============

// 文件上传（内存存储，最大 20MB）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// 支持的文档类型
const SUPPORTED_EXTS = ['.txt', '.md', '.markdown', '.pdf', '.docx', '.json', '.csv', '.log'];

/** 从上传的文件中提取纯文本 */
async function extractText(filename: string, buffer: Buffer): Promise<{ text: string; ext: string }> {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    // 动态导入，避免 pdf-parse 的调试模式副作用
    const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js') as any;
    const result = await pdfParse(buffer);
    return { text: result.text || '', ext };
  }
  if (ext === '.docx') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value || '', ext };
  }
  if (SUPPORTED_EXTS.includes(ext)) {
    return { text: buffer.toString('utf-8'), ext };
  }
  throw new Error(`不支持的文件类型: ${ext}（支持 ${SUPPORTED_EXTS.join(' / ')}）`);
}

// 上传文档
app.post("/api/kb/upload", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: "未收到文件" });
    }

    const created: any[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      // 修复中文文件名乱码（multer 默认 latin1 解码）
      const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
      try {
        const { text, ext } = await extractText(name, file.buffer);
        if (!text.trim()) {
          errors.push({ name, error: '提取的文本内容为空' });
          continue;
        }
        const doc = kb.createDocument({ name, ext, size: file.size, content: text });
        const { content, ...docMeta } = doc;
        created.push(docMeta);
      } catch (e: any) {
        errors.push({ name, error: e?.message || String(e) });
      }
    }

    console.log(`[KB] 上传完成: 成功 ${created.length}, 失败 ${errors.length}`);
    res.json({ documents: created, errors });
  } catch (error: any) {
    console.error("[KB Upload] Error:", error);
    res.status(500).json({ error: error?.message || "上传失败" });
  }
});

// 文档列表
app.get("/api/kb/documents", (req, res) => {
  try {
    res.json({ documents: kb.getAllDocuments() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取文档列表失败" });
  }
});

// 删除文档
app.delete("/api/kb/documents/:id", async (req, res) => {
  try {
    const success = await kb.deleteDocument(req.params.id);
    if (!success) return res.status(404).json({ error: "文档不存在" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "删除失败" });
  }
});

// 向量化指定文档（Embedding）
app.post("/api/kb/documents/:id/embed", async (req, res) => {
  try {
    console.log(`[KB] 开始向量化文档: ${req.params.id}`);
    const result = await kb.embedDocument(req.params.id);
    console.log(`[KB] 向量化完成: ${result.chunkCount} 个切片, 模式: ${result.mode}`);
    res.json({ success: true, ...result });
  } catch (error: any) {
    console.error("[KB Embed] Error:", error);
    res.status(500).json({ error: error?.message || "向量化失败" });
  }
});

// 检索测试
app.post("/api/kb/search", async (req, res) => {
  try {
    const { query: queryText, topK } = req.body;
    if (!queryText) return res.status(400).json({ error: "查询内容不能为空" });
    const results = await kb.search(queryText, topK);
    res.json({ results });
  } catch (error: any) {
    console.error("[KB Search] Error:", error);
    res.status(500).json({ error: error?.message || "检索失败" });
  }
});

// 获取知识库设置（含自定义 RAG 提示词）
app.get("/api/kb/settings", (req, res) => {
  try {
    const settings = kb.getSettings();
    // API Key 脱敏返回
    res.json({
      settings: {
        ...settings,
        embeddingApiKey: settings.embeddingApiKey
          ? settings.embeddingApiKey.slice(0, 6) + '****'
          : '',
      },
      hasApiKey: !!settings.embeddingApiKey,
      defaultRagPrompt: kb.DEFAULT_RAG_PROMPT,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取设置失败" });
  }
});

// 保存知识库设置
app.post("/api/kb/settings", (req, res) => {
  try {
    const { embeddingApiUrl, embeddingApiKey, embeddingModel, ragPrompt, topK, chunkSize, chunkOverlap } = req.body;
    const updates: any = {};
    if (embeddingApiUrl !== undefined) updates.embeddingApiUrl = embeddingApiUrl;
    // 前端传回的脱敏 Key（包含 ****）不覆盖原值
    if (embeddingApiKey !== undefined && !String(embeddingApiKey).includes('****')) {
      updates.embeddingApiKey = embeddingApiKey;
    }
    if (embeddingModel !== undefined) updates.embeddingModel = embeddingModel;
    if (ragPrompt !== undefined) updates.ragPrompt = ragPrompt;
    if (topK !== undefined) updates.topK = topK;
    if (chunkSize !== undefined) updates.chunkSize = chunkSize;
    if (chunkOverlap !== undefined) updates.chunkOverlap = chunkOverlap;

    kb.saveSettings(updates);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "保存设置失败" });
  }
});

// 导出知识库备份（文档 + 切片向量 + 设置）
app.get("/api/kb/export", (req, res) => {
  try {
    const backup = kb.exportKb();
    const filename = `kb-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.json(backup);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "导出失败" });
  }
});

// 导入知识库备份（覆盖式）
app.post("/api/kb/import", (req, res) => {
  try {
    const { documents, chunks, settings } = req.body || {};
    if (!Array.isArray(documents)) {
      return res.status(400).json({ error: "无效的导出文件（缺少 documents 数组）" });
    }
    const result = kb.importKb({ documents, chunks, settings });
    res.json({ success: true, ...result });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "导入失败" });
  }
});

// 智能导诊（结构化分诊）：检索知识库 → 医疗大模型 → 结构化结论
app.post("/api/triage", async (req, res) => {
  try {
    const { query, topK } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ error: "查询内容不能为空" });
    const { triage: t, sources, raw, modelNote } = await triage(query);
    // 来源脱敏/精简后返回前端
    const slimSources = sources.map((r) => ({
      docName: r.docName,
      chunkIndex: r.chunkIndex,
      score: r.score,
      chapter: r.chapter,
      docVersion: r.docVersion,
      lowConfidence: r.lowConfidence,
      content: r.content,
    }));
    res.json({ triage: t, sources: slimSources, raw, modelNote });
  } catch (error: any) {
    console.error("[Triage] Error:", error);
    res.status(500).json({ error: error?.message || "导诊失败" });
  }
});

// ============= 聊天 API =============

// 权限响应 API
app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;
  
  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);
  
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }
  
  // 清除请求
  pendingPermissions.delete(requestId);
  
  if (behavior === 'allow') {
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input
    });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: message || '用户拒绝了此操作'
    });
  }
  
  res.json({ success: true });
});

// 发送消息并获取流式响应
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, model, systemPrompt, cwd, permissionMode, useKb } = req.body;
  
  // 请求日志
  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);
  console.log(`[Chat] CWD: ${cwd || 'default'}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();
  
  if (!session) {
    // 创建新会话
    console.log(`[Chat] 创建新会话`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      model: model || defaultModel,
      sdk_session_id: null,  // 稍后从 SDK 获取
      created_at: now,
      updated_at: now
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}`);
  }

  const selectedModel = model || session.model;
  
  // 获取 SDK session ID（用于恢复对话）
  const sdkSessionId = session.sdk_session_id;

  // 创建用户消息 ID 和助手消息 ID
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 保存用户消息到数据库
  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: message,
      model: null,
      created_at: now,
      tool_calls: null
    });
    console.log(`[Chat] 用户消息已保存: ${userMessageId}`);
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 默认系统提示词
  const defaultSystemPrompt = "你是一个专业的AI助手，善于帮助用户解决各种问题。请用简洁清晰的方式回答问题。";
  
  // 工作目录：优先使用请求中的 cwd，否则使用当前目录
  const workingDir = cwd || process.cwd();

  // ===== RAG：知识库检索 + 自定义提示词注入 =====
  let finalSystemPrompt = systemPrompt || defaultSystemPrompt;
  let kbSources: Array<{ docName: string; chunkIndex: number; score: number }> = [];

  if (useKb !== false && kb.hasReadyDocuments()) {
    try {
      console.log(`[Chat] 知识库检索中...`);
      const results = await kb.search(message);
      kbSources = results.map(r => ({
        docName: r.docName,
        chunkIndex: r.chunkIndex,
        score: r.score,
        content: r.content,
        docId: r.docId,
        chapter: r.chapter,
        docVersion: r.docVersion,
      }));
      // 用户自定义的 RAG 提示词（kb_settings.ragPrompt）优先；
      // 若前端显式传入 systemPrompt（Agent 配置），则以其作为模板注入 {context}
      finalSystemPrompt = kb.buildRagSystemPrompt(results, systemPrompt);
      console.log(`[Chat] 检索到 ${results.length} 个相关切片`);
    } catch (e: any) {
      console.error(`[Chat] 知识库检索失败（降级为普通对话）:`, e?.message);
    }
  }

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Resume: ${sdkSessionId || 'none'}`);
    console.log(`[Chat] - CWD: ${workingDir}`);
    console.log(`[Chat] - PermissionMode: ${permissionMode || 'default'}`);
    
    // 创建 canUseTool 回调
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.log(`[Permission] Tool request: ${toolName}`);
      console.log(`[Permission] Input:`, JSON.stringify(input, null, 2));
      
      // bypassPermissions 模式直接放行
      if (permissionMode === 'bypassPermissions') {
        console.log(`[Permission] Bypassing permissions for ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      }
      
      // 创建权限请求
      const requestId = uuidv4();
      const permissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        sessionId: session.id,
        timestamp: Date.now()
      };
      
      // 发送权限请求到前端
      res.write(`data: ${JSON.stringify({ 
        type: "permission_request", 
        ...permissionRequest
      })}\n\n`);
      
      // 创建 Promise 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        const pending: PendingPermission = {
          resolve,
          reject,
          toolName,
          input,
          sessionId: session.id,
          timestamp: Date.now()
        };
        
        pendingPermissions.set(requestId, pending);
        
        // 设置超时
        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            console.log(`[Permission] Request timeout: ${requestId}`);
            resolve({
              behavior: 'deny',
              message: '权限请求超时'
            });
          }
        }, PERMISSION_TIMEOUT);
      });
    };
    
    // 使用统一 LLM 流接口（根据 provider 自动分发到 CodeBuddy 或 OpenAI 兼容 API）
    const stream = llm.createChatStream({
      prompt: message,
      model: selectedModel,
      systemPrompt: finalSystemPrompt,
      cwd: workingDir,
      permissionMode: permissionMode || 'default',
      canUseTool,
      resumeSessionId: sdkSessionId || undefined,
      maxTurns: 10,
    });

    let fullResponse = "";
    let toolCalls: Array<{
      id: string;
      name: string;
      input?: Record<string, unknown>;
      status: string;
      result?: string;
      isError?: boolean;
    }> = [];

    // 发送会话ID和消息ID
    res.write(`data: ${JSON.stringify({
      type: "init",
      sessionId: session.id,
      userMessageId,
      assistantMessageId,
      model: selectedModel
    })}\n\n`);

    // 发送知识库检索来源（如果有）
    if (kbSources.length > 0) {
      res.write(`data: ${JSON.stringify({ type: "kb_sources", sources: kbSources })}\n\n`);
    }

    // 处理统一格式的流事件
    for await (const event of stream) {
      console.log("[Stream] Event:", event.type);

      switch (event.type) {
        case "text_delta":
          fullResponse += event.content || "";
          res.write(`data: ${JSON.stringify({ type: "text", content: event.content })}\n\n`);
          break;

        case "tool_call": {
          const toolId = event.toolUseId || uuidv4();
          const toolCall = {
            id: toolId,
            name: event.toolName || "unknown",
            input: event.toolInput || {},
            status: "running" as string,
          };
          toolCalls.push(toolCall);
          res.write(`data: ${JSON.stringify({
            type: "tool",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            status: toolCall.status
          })}\n\n`);
          break;
        }

        case "tool_result": {
          const toolId = (event as any).toolUseId || toolCalls[toolCalls.length - 1]?.id;
          const tool = toolCalls.find(t => t.id === toolId) || toolCalls[toolCalls.length - 1];
          if (tool) {
            tool.status = event.isError ? "error" : "completed";
            tool.isError = event.isError;
            tool.result = event.toolResult || "";
            res.write(`data: ${JSON.stringify({
              type: "tool_result",
              toolId: tool.id,
              content: tool.result,
              isError: event.isError
            })}\n\n`);
          }
          break;
        }

        case "permission_request":
          // CodeBuddy 权限请求 —— 直接透传给前端
          res.write(`data: ${JSON.stringify(event)}\n\n`);
          break;

        case "done":
          // 完成时确保所有工具都标记为完成
          toolCalls.forEach(tool => {
            if (tool.status === "running") {
              tool.status = "completed";
              res.write(`data: ${JSON.stringify({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" })}\n\n`);
            }
          });
          res.write(`data: ${JSON.stringify({
            type: "done",
            duration_ms: event.duration_ms,
            cost: event.total_cost_usd
          })}\n\n`);
          break;

        case "error":
          console.error("[Stream] Error event:", event.content);
          res.write(`data: ${JSON.stringify({
            type: "error",
            content: event.content || "未知错误"
          })}\n\n`);
          break;
      }
    }

    // 保存助手消息到数据库
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
      kb_sources: kbSources.length > 0 ? JSON.stringify(kbSources) : null
    });

    // 更新会话标题（如果是第一条消息）
    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, { 
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel
      });
    }

    console.log(`[Chat] 请求完成 ✓`);
    res.end();
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Name:`, error?.name);
    console.error(`[Chat] Error Message:`, error?.message);
    console.error(`[Chat] Error Code:`, error?.code);
    console.error(`[Chat] Error Stack:`, error?.stack);
    console.error(`[Chat] Full Error:`, JSON.stringify(error, null, 2));
    
    const errorMessage = error?.message || "处理请求时发生错误";
    res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
    res.end();
  }
});

// 生产环境：托管前端构建产物（dist），并提供 SPA 路由回退。
// 仅在 dist 目录存在时启用（开发模式下由 Vite 负责前端）。
const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// 统一错误处理中间件：捕获未在本路由内处理的异常，返回一致的 JSON 错误结构
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Server', '未捕获的异常:', err?.stack || err?.message || err);
  if (!res.headersSent) {
    res.status(500).json({ error: err?.message || '服务器内部错误' });
  } else {
    res.end();
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ API 服务器已启动                      ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
║     数据库: SQLite (${dbPath})              ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
});
