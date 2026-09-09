import { Alert, Button } from 'tdesign-react';

interface LoginBannerProps {
  onGoSettings: () => void;
  /** 当前 LLM provider，用于给出准确的引导文案 */
  provider?: 'codebuddy' | 'openai-compat';
}

/** 未就绪时在主界面顶部展示的引导条，引导用户去「设置」完成配置 */
export function LoginBanner({ onGoSettings, provider }: LoginBannerProps) {
  // provider 为空/未取到时，给出最稳妥的提示
  const isOpenAi = provider === 'openai-compat';
  const title = isOpenAi ? 'OpenAI 兼容模式尚未配置' : '尚未登录 CodeBuddy';
  const message = isOpenAi
    ? 'AI 对话功能需要 API Key 才能使用。请在「设置」中填入 OpenAI 兼容接口的 Base URL / API Key / 模型名。'
    : 'AI 对话功能需要登录后才能使用。请在「设置」中配置 API Key / Auth Token，或登录 CodeBuddy CLI。';

  return (
    <div className="px-4 pt-3">
      <Alert
        theme="warning"
        title={title}
        message={message}
        operation={
          <Button size="small" theme="warning" variant="outline" onClick={onGoSettings}>
            去设置
          </Button>
        }
      />
    </div>
  );
}
