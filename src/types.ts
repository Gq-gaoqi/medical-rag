/**
 * 类型定义
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export interface Model {
  modelId: string;
  name: string;
  description?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  status: 'running' | 'completed' | 'error';
  result?: string;
  isError?: boolean;
}

/**
 * 内容块类型 - 支持文字和工具调用按顺序排列
 */
export type ContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'tool_use'; toolCall: ToolCall };

/** 知识库检索来源 */
export interface KbSource {
  docName: string;
  chunkIndex: number;
  score: number;
  content?: string;   // 命中的切片原文（用于点击引用查看）
  docId?: string;     // 来源文档 id
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;  // 保留用于兼容，存储纯文本摘要
  model?: string;
  timestamp: Date;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];  // 保留用于兼容
  contentBlocks?: ContentBlock[];  // 新增：按顺序排列的内容块
  kbSources?: KbSource[];  // 知识库检索来源
}

/** 结构化分诊结论（对应后端 server/triage.ts 的 TriageResult） */
export interface TriageResult {
  department: string;
  triageLevel: string;
  urgency: 'high' | 'medium' | 'low';
  advice: string;
  notes: string;
  disclaimer: string;
  confidence: 'high' | 'low';
}

/** 导诊检索来源（精简自后端 SearchResult） */
export interface TriageSource {
  docName: string;
  chunkIndex: number;
  score: number;
  chapter?: string;
  docVersion?: string;
  lowConfidence?: boolean;
  content?: string;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  agentId?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  createdAt: Date;
  messages: Message[];
}

export interface CustomAgent {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  icon?: string;
  color?: string;
  permissionMode?: PermissionMode;
  createdAt: Date;
  updatedAt: Date;
}

// Agent 是 CustomAgent 的别名
export type Agent = CustomAgent;

export type Theme = 'light' | 'dark';

/**
 * 权限请求 - 用于工具调用确认
 */
export interface PermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

/**
 * 权限响应
 */
export interface PermissionResponse {
  requestId: string;
  behavior: 'allow' | 'deny';
  message?: string;
}
