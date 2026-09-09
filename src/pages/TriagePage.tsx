import { useState, useCallback } from 'react';
import { Button, Tag } from 'tdesign-react';
import { HeartIcon } from 'tdesign-icons-react';
import { APP_CONFIG } from '../config';
import { triage as callTriage } from '../utils/api';
import type { TriageResult, TriageSource } from '../types';

/** 常见主诉快选（点击直接发起导诊） */
const QUICK_PICKS = [
  '反复头痛还伴恶心呕吐',
  '胸口压榨样痛且出冷汗',
  '孕期出血伴腹痛',
  '高血压平时吃什么药',
  '一侧肢体无力说话大舌头',
  '儿童反复发烧出疹',
  '鱼刺卡喉挂哪科',
  '长期腹泻下腹痛',
];

/** 紧急度 → 颜色/文案（克制配色，紧急红、亚急橙、平诊绿） */
const URGENCY_META: Record<TriageResult['urgency'], { label: string; color: string }> = {
  high: { label: '紧急', color: '#e34d59' },
  medium: { label: '亚急', color: '#ed7b2f' },
  low: { label: '平诊', color: '#059445' },
};

export function TriagePage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    triage: TriageResult | null;
    sources: TriageSource[];
    raw: string;
    modelNote?: string;
  } | null>(null);
  const [error, setError] = useState('');

  const run = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text) return;
    setQuery(text);
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await callTriage(text);
      if (!data.triage && data.modelNote) setError(data.modelNote);
      setResult(data);
    } catch (e: any) {
      setError(e?.message || '导诊请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const t = result?.triage ?? null;
  const urg = t ? URGENCY_META[t.urgency] : null;

  return (
    <div className="flex-1 overflow-y-auto" style={{ backgroundColor: 'var(--td-bg-color-page)' }}>
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* 标题 */}
        <div className="flex items-center gap-2.5 mb-1">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          >
            <HeartIcon size={18} color="white" />
          </div>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
            智能医疗导诊
          </h2>
        </div>
        <p className="text-sm mb-6" style={{ color: 'var(--td-text-color-placeholder)' }}>
          基于知识库检索 + 大模型分诊。描述你的症状，获取推荐科室与就诊建议。
          <span style={{ color: 'var(--td-text-color-placeholder)' }}>（结果由 AI 生成，仅供参考，紧急情况请立即拨打 120。）</span>
        </p>

        {/* 主诉输入 */}
        <div className="rounded-xl p-4 mb-4" style={{ backgroundColor: 'var(--td-bg-color-container)' }}>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(query);
            }}
            rows={3}
            placeholder="例如：反复头痛还伴恶心呕吐，应该挂哪个科？"
            className="w-full resize-none bg-transparent outline-none text-sm"
            style={{ color: 'var(--td-text-color-primary)' }}
          />
          <div className="flex justify-end mt-2">
            <Button theme="primary" onClick={() => run(query)} loading={loading} disabled={!query.trim()}>
              开始导诊
            </Button>
          </div>
        </div>

        {/* 常见主诉快选 */}
        <div className="mb-6">
          <div className="text-xs mb-2" style={{ color: 'var(--td-text-color-placeholder)' }}>
            常见主诉（点击快速体验）
          </div>
          <div className="flex flex-wrap gap-2">
            {QUICK_PICKS.map((q) => (
              <button
                key={q}
                onClick={() => run(q)}
                className="px-3 py-1.5 rounded-full text-xs cursor-pointer transition-colors"
                style={{
                  backgroundColor: 'var(--td-bg-color-component)',
                  color: 'var(--td-text-color-secondary)',
                  border: '1px solid var(--td-component-border)',
                }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* 加载态 */}
        {loading && (
          <div className="text-center py-10 text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
            正在检索知识库并生成分诊建议…
          </div>
        )}

        {/* 错误 */}
        {error && !loading && (
          <div
            className="rounded-lg px-4 py-3 text-sm mb-4"
            style={{ backgroundColor: 'var(--td-error-color-1)', color: 'var(--td-error-color-7)' }}
          >
            {error}
          </div>
        )}

        {/* 分诊卡片 */}
        {!loading && t && (
          <div
            className="rounded-xl p-5 mb-4"
            style={{
              backgroundColor: 'var(--td-bg-color-container)',
              borderLeft: `4px solid ${urg?.color ?? 'var(--td-brand-color)'}`,
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  推荐就诊科室
                </div>
                <div className="text-2xl font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
                  {t.department}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {urg && (
                  <Tag
                    style={{ backgroundColor: urg.color, color: '#fff', borderColor: urg.color }}
                  >
                    紧急度：{urg.label}
                  </Tag>
                )}
                <Tag variant="outline" theme={t.confidence === 'low' ? 'warning' : 'success'}>
                  分诊级别：{t.triageLevel}
                </Tag>
              </div>
            </div>

            {t.advice && (
              <div className="mb-3">
                <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  就诊建议
                </div>
                <div className="text-sm" style={{ color: 'var(--td-text-color-primary)' }}>
                  {t.advice}
                </div>
              </div>
            )}

            {t.notes && (
              <div className="mb-3">
                <div className="text-xs mb-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  注意事项
                </div>
                <div
                  className="text-sm whitespace-pre-wrap"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                >
                  {t.notes}
                </div>
              </div>
            )}

            {t.confidence === 'low' && (
              <div
                className="rounded-md px-3 py-2 text-xs mb-3"
                style={{ backgroundColor: 'var(--td-warning-color-1)', color: 'var(--td-warning-color-7)' }}
              >
                ⚠️ 知识库匹配度较低，建议优先线下就诊或挂全科 / 急诊进一步评估。
              </div>
            )}

            <div
              className="text-xs rounded-md px-3 py-2"
              style={{ backgroundColor: 'var(--td-bg-color-component)', color: 'var(--td-text-color-placeholder)' }}
            >
              {t.disclaimer}
            </div>
          </div>
        )}

        {/* 检索来源（带章节 / 版本） */}
        {!loading && result && result.sources.length > 0 && (
          <div className="mb-4">
            <div className="text-xs mb-2" style={{ color: 'var(--td-text-color-placeholder)' }}>
              分诊依据（知识库命中 {result.sources.length} 段）
            </div>
            <div className="space-y-2">
              {result.sources.map((s, i) => (
                <div
                  key={i}
                  className="rounded-lg px-3 py-2 text-xs"
                  style={{ backgroundColor: 'var(--td-bg-color-container)' }}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span style={{ color: 'var(--td-brand-color)' }}>{s.docName}</span>
                    <span style={{ color: 'var(--td-text-color-placeholder)' }}>
                      相关度 {(s.score * 100).toFixed(0)}%
                      {s.chapter ? ` · ${s.chapter}` : ''}
                      {s.docVersion ? ` · v${s.docVersion}` : ''}
                    </span>
                  </div>
                  <div
                    className="line-clamp-2"
                    style={{ color: 'var(--td-text-color-secondary)' }}
                  >
                    {s.content}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 未配置模型时的兜底提示 */}
        {!loading && result && !t && !error && (
          <div
            className="rounded-lg px-4 py-3 text-sm"
            style={{ backgroundColor: 'var(--td-bg-color-container)', color: 'var(--td-text-color-secondary)' }}
          >
            已检索到相关片段，但大模型未配置（请到「设置」配置 OPENAI_API_KEY 或 CodeBuddy 凭据）无法生成结构化分诊结论。
            可在上方「分诊依据」查看命中的知识库内容。
          </div>
        )}
      </div>
    </div>
  );
}
