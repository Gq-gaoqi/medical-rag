/**
 * 安全的 fetch + JSON 解析辅助函数
 *
 * 解决两个常见问题:
 * 1. 后端未启动 / Vite 代理转发失败时,Response body 为空,response.json() 抛
 *    "Failed to execute 'json' on 'Response': Unexpected end of JSON input"
 * 2. 5xx 错误响应直接当成功处理,后端返回的 error 字段被忽略
 *
 * 用法:
 *   const data = await safeJson('/api/foo');
 *   if (data) { ... }
 *
 *   await safeJson('/api/foo', { method: 'POST', body: JSON.stringify(payload) });
 */

export class ApiError extends Error {
  status: number;
  body: string;
  data: any;

  constructor(message: string, status: number, body: string, data: any = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.data = data;
  }
}

export interface SafeJsonOptions extends RequestInit {
  /** 当 HTTP 非 2xx 时,是否自动抛错(默认 true) */
  throwOnError?: boolean;
  /** 自定义错误消息前缀 */
  errorPrefix?: string;
}

/**
 * fetch + text + JSON.parse 的安全封装。
 *
 * - 后端没响应 / body 为空: 抛 ApiError(后端服务可能未启动)
 * - body 不是合法 JSON:      抛 ApiError(原始文本附在 message)
 * - HTTP 非 2xx:             抛 ApiError(尝试从 body 抽取 error 字段)
 * - 成功:                    返回解析后的对象
 */
export async function safeJson<T = any>(
  url: string,
  options: SafeJsonOptions = {},
): Promise<T> {
  const { throwOnError = true, errorPrefix = '', ...init } = options;

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (e: any) {
    // 网络层错误(DNS 失败 / 连接被拒 / CORS)
    throw new ApiError(
      `网络请求失败: ${e?.message || e} (请检查后端服务 ${url} 是否启动)`,
      0,
      '',
    );
  }

  // 读取原始 body(避免 response.json() 在空 body 上抛错)
  const text = await response.text().catch(() => '');

  // 解析 JSON
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(
        `${errorPrefix}服务器响应不是有效 JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
        response.status,
        text,
      );
    }
  }

  // 统一处理非 2xx
  if (!response.ok) {
    const serverMsg = data?.error || data?.message || text.slice(0, 200);
    // body 为空 + 5xx: 高度怀疑是后端宕了(Express/代理返回空 body)
    const hint =
      !text && response.status >= 500
        ? ' (后端服务可能未启动,请检查 dev:server 进程)'
        : '';
    throw new ApiError(
      `${errorPrefix}请求失败 (HTTP ${response.status}): ${serverMsg || response.statusText || '无响应'}${hint}`,
      response.status,
      text,
      data,
    );
  }

  // 成功但 body 为空(理论上后端不应这样,但防御一下)
  if (data === null) {
    throw new ApiError(
      `${errorPrefix}服务器返回空响应 (HTTP ${response.status})`,
      response.status,
      text,
    );
  }

  return data as T;
}

/** safeJson 的容错版本: 出错时返回 fallback 而不是抛错(适合不阻塞 UI 的轮询/加载场景) */
export async function safeJsonOrNull<T = any>(
  url: string,
  options: SafeJsonOptions = {},
): Promise<T | null> {
  try {
    return await safeJson<T>(url, { throwOnError: false, ...options });
  } catch {
    return null;
  }
}

/** 智能导诊：调用后端 /api/triage，返回结构化分诊结论与检索来源 */
export async function triage(
  query: string,
): Promise<{
  triage: import('../types').TriageResult | null;
  sources: import('../types').TriageSource[];
  raw: string;
  modelNote?: string;
}> {
  return safeJson('/api/triage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}
