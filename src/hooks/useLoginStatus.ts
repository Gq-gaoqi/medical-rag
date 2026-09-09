import { useState, useEffect, useCallback } from 'react';
import { safeJson, safeJsonOrNull } from '../utils/api';

export interface LoginStatus {
  isLoggedIn: boolean;
  /** 任意一种 provider 已就绪：CodeBuddy 登录成功 / OpenAI 兼容模式已配 Key */
  ready: boolean;
  /** 当前 LLM 提供商；来自 /api/llm-config */
  provider?: 'codebuddy' | 'openai-compat';
  checking: boolean;
  method?: 'env' | 'cli' | 'none';
  error?: string;
  apiKey?: string;
}

/** 轮询 /api/check-login + /api/llm-config，给出当前"是否可对话"的就绪态 */
export function useLoginStatus() {
  const [status, setStatus] = useState<LoginStatus>({
    isLoggedIn: false,
    ready: false,
    checking: true,
  });

  const check = useCallback(async () => {
    setStatus(prev => ({ ...prev, checking: true, error: undefined }));
    try {
      // 并行：登录态 + LLM 配置。任意一个失败都不影响另一个的结果。
      const [login, llm] = await Promise.all([
        safeJson<{
          isLoggedIn?: boolean;
          method?: 'env' | 'cli' | 'none';
          error?: string;
          apiKey?: string;
        }>('/api/check-login', { errorPrefix: '检查登录失败: ' }).catch(() => null),
        safeJsonOrNull<{ provider?: 'codebuddy' | 'openai-compat'; openaiApiKey?: string }>(
          '/api/llm-config',
        ),
      ]);

      const provider = llm?.provider;
      const hasOpenAiKey = !!llm?.openaiApiKey;
      const isLoggedIn = !!login?.isLoggedIn;
      // 就绪条件：CodeBuddy 模式已登录 / OpenAI 兼容模式已配 Key
      const ready = isLoggedIn || (provider === 'openai-compat' && hasOpenAiKey);

      setStatus({
        isLoggedIn,
        ready,
        provider,
        checking: false,
        method: login?.method,
        error: login?.error,
        apiKey: login?.apiKey,
      });
    } catch (e: any) {
      setStatus({
        isLoggedIn: false,
        ready: false,
        checking: false,
        error: e?.message || String(e),
      });
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  return { ...status, check };
}
