/**
 * LLM 提供商抽象层
 *
 * 统一封装 CodeBuddy SDK 与 OpenAI 兼容 API（覆盖 OpenAI / Azure / Ollama /
 * DeepSeek / 通义千问 / 智谱 / 本地 vLLM 等所有兼容 /v1/chat/completions 的服务）。
 *
 * 使用方式：
 *   1. 通过环境变量或前端设置配置 provider
 *   2. 调用 createChatStream() 获取统一的事件流
 */

import { query, CanUseTool } from "@tencent-ai/agent-sdk";

// ─── 类型定义 ─────────────────────────────────────────────

export type LlmProvider = "codebuddy" | "openai-compat";

export interface LlmConfig {
  /** 提供商标识 */
  provider: LlmProvider;
  // ---- CodeBuddy ----
  codebuddyApiKey?: string;
  codebuddyAuthToken?: string;
  codebuddyBaseUrl?: string;
  // ---- OpenAI 兼容 ----
  openaiApiKey?: string;
  openaiBaseUrl?: string;   // 默认 https://api.openai.com/v1
  openaiModel?: string;     // 默认 gpt-4o-mini
}

/** 流事件 —— 前端统一消费此格式 */
export type StreamEventType =
  | "text_delta"
  | "tool_call"
  | "tool_result"
  | "done"
  | "error"
  | "permission_request";   // 仅 CodeBuddy

export interface StreamEvent {
  type: StreamEventType;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResult?: string;
  isError?: boolean;
  // done 元信息
  duration_ms?: number;
  total_cost_usd?: number;
  // permission_request 字段（透传）
  requestId?: string;
  [key: string]: unknown;
}

export interface ChatStreamParams {
  prompt: string;
  model: string;
  systemPrompt?: string;
  cwd?: string;
  permissionMode?: string;
  canUseTool?: CanUseTool;
  resumeSessionId?: string;    // CodeBuddy 会话恢复
  messages?: Array<{ role: string; content: string }>;  // OpenAI 兼容模式的历史消息
  maxTurns?: number;
}

// ─── 全局配置 ─────────────────────────────────────────────

let currentConfig: LlmConfig = {
  provider: (process.env.LLM_PROVIDER as LlmProvider) || "openai-compat",
  codebuddyApiKey: process.env.CODEBUDDY_API_KEY,
  codebuddyAuthToken: process.env.CODEBUDDY_AUTH_TOKEN,
  codebuddyBaseUrl: process.env.CODEBUDDY_BASE_URL,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  openaiModel: process.env.OPENAI_MODEL,
};

/** 运行时更新配置（前端设置页调用） */
export function updateLlmConfig(partial: Partial<LlmConfig>): LlmConfig {
  currentConfig = { ...currentConfig, ...partial };
  return currentConfig;
}

/** 读取当前配置 */
export function getLlmConfig(): LlmConfig {
  return { ...currentConfig };
}

// ─── CodeBuddy 适配器 ─────────────────────────────────────

async function* codebuddyStream(
  params: ChatStreamParams,
): AsyncGenerator<StreamEvent> {
  const stream = query({
    prompt: params.prompt,
    options: {
      cwd: params.cwd || process.cwd(),
      model: params.model,
      maxTurns: params.maxTurns ?? 10,
      systemPrompt: params.systemPrompt,
      permissionMode: (params.permissionMode as any) || "default",
      canUseTool: params.canUseTool,
      ...(params.resumeSessionId ? { resume: params.resumeSessionId } : {}),
    },
  });

  let fullText = "";
  const startTime = Date.now();

  for await (const msg of stream) {
    const m = msg as any; // SDK 流事件类型是严格联合，用 any 处理所有分支
    switch (m.type) {
      case "text":
        fullText += m.content;
        yield { type: "text_delta", content: m.content };
        break;

      case "tool_use": {
        yield {
          type: "tool_call",
          toolName: m.name,
          toolInput: m.input,
          toolUseId: m.toolUseID,
        };
        break;
      }

      case "tool_result": {
        yield {
          type: "tool_result",
          toolName: m.name,
          toolResult: String(m.content || ""),
          isError: m.isError,
        };
        break;
      }

      case "stream_event": {
        // 透传 permission_request 等 SDK 内部事件
        if (m.event === "permission_request") {
          yield { type: "permission_request", ...m };
        }
        break;
      }

      case "done": {
        yield {
          type: "done",
          duration_ms: Date.now() - startTime,
          total_cost_usd: m.total_cost_usd ?? 0,
        };
        break;
      }

      default:
        // 忽略未知事件类型（如 file-history-snapshot）
        break;
    }
  }

  // 如果循环结束还没发 done，补一个
  if (fullText.length > 0) {
    // 已在 done 中处理；这里仅作为安全网
  }
}

// ─── OpenAI 兼容适配器 ─────────────────────────────────────

/**
 * 解析 OpenAI SSE 行。
 * OpenAI 格式：data: {...JSON...}\n\n 或 data: [DONE]\n\n
 */
function parseOpenaiLine(line: string): StreamEvent | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6).trim();
  if (payload === "[DONE]") return { type: "done" };

  try {
    const chunk = JSON.parse(payload);
    const choice = chunk.choices?.[0];
    if (!choice) return null;

    const delta = choice.delta;

    // content delta
    if (delta?.content) {
      return { type: "text_delta", content: delta.content };
    }

    // tool_calls delta
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.arguments) {
          return {
            type: "tool_call",
            toolName: tc.function.name || "unknown",
            toolInput: { arguments: tc.function.arguments },
            toolUseId: tc.id,
          };
        }
      }
    }

    // finish_reason
    if (choice.finish_reason && !delta?.content) {
      return { type: "done" };
    }

    return null;
  } catch {
    return null;
  }
}

async function* openaiCompatStream(
  params: ChatStreamParams,
): AsyncGenerator<StreamEvent> {
  const baseUrl =
    currentConfig.openaiBaseUrl ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const apiKey =
    currentConfig.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const model =
    params.model ||
    currentConfig.openaiModel ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";

  // 构建消息列表
  const messages: Array<{ role: string; content: string }> = [
    ...(params.messages || []),
  ];

  // 如果没有历史消息，至少放入系统提示词和用户消息
  if (messages.length === 0) {
    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.prompt });
  } else if (params.systemPrompt && messages[0]?.role !== "system") {
    messages.unshift({ role: "system", content: params.systemPrompt });
  }

  // 追加当前用户消息（如果最后一条不是 user）
  if (
    messages.length === 0 ||
    messages[messages.length - 1].role !== "user"
  ) {
    messages.push({ role: "user", content: params.prompt });
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const startTime = Date.now();

  console.log(`[LLM/OpenAI] POST ${url}`);
  console.log(`[LLM/OpenAI] Model: ${model}`);
  console.log(`[LLM/OpenAI] Messages: ${messages.length} 条`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      yield {
        type: "error",
        content: `OpenAI API 错误 (${response.status}): ${errBody.slice(0, 500)}`,
      };
      return;
    }

    if (!response.body) {
      yield { type: "error", content: "响应体为空" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // 最后一个可能不完整，保留
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const event = parseOpenaiLine(trimmed);
        if (event) {
          if (event.type === "done") {
            event.duration_ms = Date.now() - startTime;
          }
          yield event;
        }
      }
    }

    // 处理缓冲区剩余内容
    if (buffer.trim()) {
      const event = parseOpenaiLine(buffer.trim());
      if (event && event.type !== "done") {
        yield event;
      }
    }

    // 确保 done 事件发出
    yield { type: "done", duration_ms: Date.now() - startTime };
  } catch (err: any) {
    yield {
      type: "error",
      content: `OpenAI 请求失败: ${err?.message || String(err)}`,
    };
  }
}

// ─── 统一入口 ───────────────────────────────────────────────

/**
 * 创建聊天流 —— 根据当前配置的 provider 自动分发。
 *
 * 用法：
 *   for await (const event of createChatStream(params)) {
 *     res.write(`data: ${JSON.stringify(event)}\n\n`);
 *   }
 */
export async function* createChatStream(
  params: ChatStreamParams,
): AsyncGenerator<StreamEvent> {
  switch (currentConfig.provider) {
    case "openai-compat":
      yield* openaiCompatStream(params);
      break;
    case "codebuddy":
    default:
      yield* codebuddyStream(params);
      break;
  }
}

// ─── 非流式补全（供 rerank 二阶段重排等需要结构化输出的场景） ──

export interface CompleteParams {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  temperature?: number;
}

/**
 * 判断当前 provider 是否已配置可用（即存在能发起请求的凭据）。
 * openai-compat 需要 apiKey；codebuddy 需要 apiKey / authToken 之一。
 * rerank 阶段据此决定是否走 LLM 重排，否则降级为 stage-1 顺序。
 */
export function isLlmConfigured(): boolean {
  if (currentConfig.provider === "openai-compat") {
    return !!(currentConfig.openaiApiKey || process.env.OPENAI_API_KEY);
  }
  // codebuddy
  return !!(
    currentConfig.codebuddyApiKey ||
    process.env.CODEBUDDY_API_KEY ||
    process.env.CODEBUDDY_AUTH_TOKEN
  );
}

/**
 * 非流式补全：返回模型生成的完整文本（非 SSE）。
 * - openai-compat：直接 POST /chat/completions（stream:false），解析 choices[0].message.content。
 * - codebuddy：复用流式 query，累计 text_delta 直到 done。
 * 用于 rerank 这种「一次调用拿到结构化/打分结果」的场景，比 SSE 更省心。
 */
export async function complete(params: CompleteParams): Promise<string> {
  if (currentConfig.provider === "openai-compat") {
    return openaiComplete(params);
  }
  return codebuddyComplete(params);
}

/** OpenAI 兼容：非流式补全 */
async function openaiComplete(params: CompleteParams): Promise<string> {
  const baseUrl =
    currentConfig.openaiBaseUrl ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const apiKey =
    currentConfig.openaiApiKey || process.env.OPENAI_API_KEY || "";
  const model =
    params.model ||
    currentConfig.openaiModel ||
    process.env.OPENAI_MODEL ||
    "gpt-4o-mini";
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  console.log(`[LLM/OpenAI/complete] POST ${url} model=${model}`);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(params.systemPrompt
          ? [{ role: "system" as const, content: params.systemPrompt }]
          : []),
        { role: "user" as const, content: params.prompt },
      ],
      stream: false,
      temperature: params.temperature ?? 0,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`OpenAI 补全失败 (${resp.status}): ${body.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/** CodeBuddy：收集流式输出为非流式文本 */
async function codebuddyComplete(params: CompleteParams): Promise<string> {
  let text = "";
  for await (const ev of codebuddyStream({
    prompt: params.prompt,
    systemPrompt: params.systemPrompt,
    model: params.model || "",
  })) {
    if (ev.type === "text_delta") text += ev.content ?? "";
    else if (ev.type === "error")
      throw new Error(ev.content || "CodeBuddy 补全失败");
  }
  return text;
}

// ─── 模型列表 ──────────────────────────────────────────────

/**
 * 获取可用模型列表。CodeBuddy 从 SDK 获取；
 * OpenAI 兼容模式返回用户配置的模型或常用预设。
 */
export async function fetchAvailableModels(): Promise<
  Array<{ modelId: string; name: string; description?: string }>
> {
  if (currentConfig.provider === "openai-compat") {
    // OpenAI 兼容模式：返回配置的模型 + 常用预设
    const configured = currentConfig.openaiModel || process.env.OPENAI_MODEL;
    const presets = [
      { modelId: "gpt-4o", name: "GPT-4o" },
      { modelId: "gpt-4o-mini", name: "GPT-4o Mini" },
      { modelId: "gpt-4-turbo", name: "GPT-4 Turbo" },
      { modelId: "o3", name: "O3" },
      { modelId: "deepseek-chat", name: "DeepSeek Chat" },
      { modelId: "deepseek-reasoner", name: "DeepSeek Reasoner" },
      { modelId: "qwen-turbo", name: "通义千问 Turbo" },
      { modelId: "qwen-plus", name: "通义千问 Plus" },
      { modelId: "glm-4-plus", name: "GLM-4 Plus" },
      { modelId: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
      { modelId: "llama3.1-70b", name: "Llama 3.1 70B (Ollama)" },
    ];
    // 如果有自定义模型且不在预设中，加到最前面
    if (configured && !presets.find((p) => p.modelId === configured)) {
      presets.unshift({ modelId: configured, name: `${configured} (自定义)` });
    }
    return presets;
  }

  // CodeBuddy 模式：从 SDK 获取
  const { unstable_v2_createSession } = await import("@tencent-ai/agent-sdk");
  try {
    const session = await unstable_v2_createSession({});
    const models = await session.getAvailableModels();
    return models.map((m: any) => ({
      modelId: m.id || m.modelId,
      name: m.name || m.id || m.modelId,
      description: m.description,
    }));
  } catch (e: any) {
    console.error("[LLM] 获取 CodeBuddy 模型列表失败:", e.message);
    return [];
  }
}
