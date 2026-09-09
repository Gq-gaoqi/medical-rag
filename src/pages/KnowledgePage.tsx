import { useState, useEffect, useCallback, useRef } from 'react';
import { Button, Tag, Input, Textarea, InputNumber, MessagePlugin, Popconfirm, Tabs, Dialog, Switch, Select } from 'tdesign-react';
import { UploadIcon, DeleteIcon, RefreshIcon, SearchIcon, SaveIcon, BrowseIcon } from 'tdesign-icons-react';
import { FileText, Database, Sparkles } from 'lucide-react';
import { safeJson, safeJsonOrNull } from '../utils/api';

const { TabPanel } = Tabs;

interface KbDoc {
  id: string;
  name: string;
  ext: string;
  size: number;
  status: 'uploaded' | 'embedding' | 'ready' | 'error';
  chunk_count: number;
  error: string | null;
  created_at: string;
  embedded_at: string | null;
  doc_version?: string;
}

interface KbSettingsData {
  embeddingApiUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  ragPrompt: string;
  topK: number;
  chunkSize: number;
  chunkOverlap: number;
}

interface SearchResult {
  docId: string;
  docName: string;
  chunkIndex: number;
  content: string;
  score: number;
}

const STATUS_MAP: Record<KbDoc['status'], { label: string; theme: 'default' | 'primary' | 'warning' | 'success' | 'danger' }> = {
  uploaded: { label: '待向量化', theme: 'warning' },
  embedding: { label: '向量化中', theme: 'primary' },
  ready: { label: '已就绪', theme: 'success' },
  error: { label: '失败', theme: 'danger' },
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function KnowledgePage() {
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [uploading, setUploading] = useState(false);
  const [embeddingIds, setEmbeddingIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 设置
  const [settings, setSettings] = useState<KbSettingsData | null>(null);
  const [defaultRagPrompt, setDefaultRagPrompt] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  // 检索测试
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  // 自动向量化开关（默认开启，上传后自动入库）
  const [autoEmbed, setAutoEmbed] = useState<boolean>(() => localStorage.getItem('kbAutoEmbed') !== 'false');
  const [embeddingAll, setEmbeddingAll] = useState(false);

  // 文档预览
  const [previewDoc, setPreviewDoc] = useState<KbDoc | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);

  // ===== 数据加载 =====
  const fetchDocs = useCallback(async () => {
    try {
      const data = await safeJsonOrNull<{ documents?: any[] }>('/api/kb/documents');
      setDocs(data?.documents || []);
    } catch {
      MessagePlugin.error('获取文档列表失败');
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const data = await safeJsonOrNull<{ settings: any; defaultRagPrompt?: string }>('/api/kb/settings');
      if (data) {
        setSettings(data.settings);
        setDefaultRagPrompt(data.defaultRagPrompt || '');
      }
    } catch {
      MessagePlugin.error('获取设置失败');
    }
  }, []);

  useEffect(() => {
    fetchDocs();
    fetchSettings();
  }, [fetchDocs, fetchSettings]);

  // ===== 上传 =====
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const formData = new FormData();
    Array.from(files).forEach(f => formData.append('files', f));

    setUploading(true);
    try {
      const data = await safeJson<{ documents?: KbDoc[]; errors?: { name: string; error: string }[] }>(
        '/api/kb/upload',
        { method: 'POST', body: formData, errorPrefix: '上传失败: ' },
      );
      const uploaded = data.documents || [];
      const errors = data.errors || [];
      if (uploaded.length > 0) {
        MessagePlugin.success(`成功上传 ${uploaded.length} 个文档，请点击「向量化」完成入库`);
      }
      if (errors.length > 0) {
        errors.forEach((err) => {
          MessagePlugin.warning(`${err.name}: ${err.error}`, 5000);
        });
      }
      fetchDocs();
      // 开启自动向量化时，上传后自动入库
      if (autoEmbed && uploaded.length > 0) {
        for (const d of uploaded) {
          await embedById(d.id);
        }
        fetchDocs();
      }
    } catch (err: any) {
      MessagePlugin.error(err?.message || '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ===== 向量化 =====
  /** 底层：对单个文档触发向量化，返回结果或 null（出错已提示） */
  const embedById = useCallback(async (id: string): Promise<{ chunkCount: number; mode: string } | null> => {
    try {
      const data = await safeJson<{ chunkCount: number; mode: string }>(
        `/api/kb/documents/${id}/embed`,
        { method: 'POST', errorPrefix: '向量化失败: ' },
      );
      return data;
    } catch (err: any) {
      MessagePlugin.error(err?.message || '向量化失败');
      return null;
    }
  }, []);

  const handleEmbed = async (doc: KbDoc) => {
    setEmbeddingIds(prev => new Set(prev).add(doc.id));
    setDocs(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'embedding' as const } : d));
    try {
      const data = await embedById(doc.id);
      if (data) {
        MessagePlugin.success(
          `「${doc.name}」向量化完成：${data.chunkCount} 个切片（${data.mode === 'api' ? 'Embedding API' : '本地向量'}模式）`
        );
      }
    } finally {
      setEmbeddingIds(prev => {
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
      fetchDocs();
    }
  };

  /** 批量向量化：对所有「待向量化 / 失败」文档依次入库 */
  const handleEmbedAll = async () => {
    const pending = docs.filter(d => d.status === 'uploaded' || d.status === 'error');
    if (pending.length === 0) {
      MessagePlugin.info('没有需要向量化的文档');
      return;
    }
    setEmbeddingAll(true);
    let ok = 0;
    for (const doc of pending) {
      setEmbeddingIds(prev => new Set(prev).add(doc.id));
      setDocs(prev => prev.map(d => d.id === doc.id ? { ...d, status: 'embedding' as const } : d));
      const data = await embedById(doc.id);
      if (data) ok += 1;
      setEmbeddingIds(prev => {
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
    }
    setEmbeddingAll(false);
    fetchDocs();
    MessagePlugin.success(`批量向量化完成：${ok}/${pending.length} 个文档已入库`);
  };

  // ===== 文档预览 =====
  const openPreview = async (doc: KbDoc) => {
    setPreviewDoc(doc);
    setPreviewContent('');
    setPreviewLoading(true);
    try {
      const data = await safeJsonOrNull<{ content?: string }>(`/api/kb/documents/${doc.id}`);
      setPreviewContent(data?.content || '（无内容）');
    } catch {
      setPreviewContent('加载失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  // ===== 导出 / 导入备份 =====
  const handleExport = async () => {
    try {
      const res = await fetch('/api/kb/export');
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kb-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      MessagePlugin.success('知识库已导出');
    } catch (err: any) {
      MessagePlugin.error(err?.message || '导出失败');
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const data = await safeJson<{ docCount: number; chunkCount: number }>(
        '/api/kb/import',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          errorPrefix: '导入失败: ',
        },
      );
      MessagePlugin.success(`导入完成：${data.docCount} 个文档、${data.chunkCount} 个切片`);
      fetchDocs();
      fetchSettings();
    } catch (err: any) {
      MessagePlugin.error(err?.message || '导入失败（请确认是有效的备份文件）');
    } finally {
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  // ===== 删除 =====
  const handleDelete = async (doc: KbDoc) => {
    try {
      const res = await fetch(`/api/kb/documents/${doc.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('删除失败');
      MessagePlugin.success('已删除');
      fetchDocs();
    } catch (err: any) {
      MessagePlugin.error(err?.message || '删除失败');
    }
  };

  // ===== 保存设置 =====
  const handleSaveSettings = async () => {
    if (!settings) return;
    setSavingSettings(true);
    try {
      await safeJson('/api/kb/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
        errorPrefix: '保存设置失败: ',
      });
      MessagePlugin.success('设置已保存');
      fetchSettings();
    } catch (err: any) {
      MessagePlugin.error(err?.message || '保存失败');
    } finally {
      setSavingSettings(false);
    }
  };

  // ===== 检索测试 =====
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearched(false);
    try {
      const data = await safeJson<{ results?: any[] }>(
        '/api/kb/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery }),
          errorPrefix: '检索失败: ',
        },
      );
      setSearchResults(data.results || []);
      setSearched(true);
    } catch (err: any) {
      MessagePlugin.error(err?.message || '检索失败');
    } finally {
      setSearching(false);
    }
  };

  const readyCount = docs.filter(d => d.status === 'ready').length;
  const pendingCount = docs.filter(d => d.status === 'uploaded' || d.status === 'error').length;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* 标题 */}
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          >
            <Database size={20} color="white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold" style={{ color: 'var(--td-text-color-primary)' }}>
              知识库管理
            </h1>
            <p className="text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
              共 {docs.length} 个文档，{readyCount} 个已就绪 · 上传文档 → 向量化 → 对话时自动检索
            </p>
          </div>
        </div>

        <Tabs defaultValue="docs" theme="normal">
          {/* ============ 文档管理 ============ */}
          <TabPanel value="docs" label="文档管理">
            <div className="py-4 space-y-4">
              {/* 上传区 */}
              <div
                className="border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors"
                style={{ borderColor: 'var(--td-component-border)' }}
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.markdown,.pdf,.docx,.json,.csv,.log"
                  className="hidden"
                  onChange={handleFileSelect}
                />
                <UploadIcon size="28px" style={{ color: 'var(--td-brand-color)' }} />
                <p className="mt-2 text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                  {uploading ? '上传中...' : '点击上传文档（可多选）'}
                </p>
                <p className="mt-1 text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  支持 txt / md / pdf / docx / json / csv / log，单个最大 20MB
                </p>
              </div>

              {/* 批量操作栏 */}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--td-text-color-secondary)' }}>
                  <Switch
                    size="small"
                    value={autoEmbed}
                    onChange={(v) => {
                      const val = Boolean(v);
                      setAutoEmbed(val);
                      localStorage.setItem('kbAutoEmbed', String(val));
                    }}
                  />
                  上传后自动向量化
                </label>
                <Button
                  size="small"
                  theme="default"
                  variant="outline"
                  icon={<Sparkles size={14} />}
                  loading={embeddingAll}
                  disabled={pendingCount === 0}
                  onClick={handleEmbedAll}
                >
                  全部向量化{pendingCount > 0 ? `（${pendingCount}）` : ''}
                </Button>
                <div className="flex items-center gap-2">
                  <Button size="small" theme="default" variant="outline" onClick={handleExport}>
                    导出备份
                  </Button>
                  <Button size="small" theme="default" variant="outline" onClick={() => importInputRef.current?.click()}>
                    导入备份
                  </Button>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={handleImportFile}
                  />
                </div>
              </div>

              {/* 文档列表 */}
              <div className="space-y-2">
                {docs.length === 0 && (
                  <div className="text-center py-10 text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
                    还没有文档，先上传一个吧
                  </div>
                )}
                {docs.map(doc => {
                  const st = STATUS_MAP[doc.status];
                  const isEmbedding = embeddingIds.has(doc.id) || doc.status === 'embedding';
                  return (
                    <div
                      key={doc.id}
                      className="flex items-center gap-3 p-4 rounded-lg"
                      style={{ backgroundColor: 'var(--td-bg-color-container)' }}
                    >
                      <FileText size={20} style={{ color: 'var(--td-brand-color)', flexShrink: 0 }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm truncate" style={{ color: 'var(--td-text-color-primary)' }}>
                            {doc.name}
                          </span>
                          <Tag theme={st.theme} variant="light" size="small">{st.label}</Tag>
                        </div>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--td-text-color-secondary)' }}>
                          {formatSize(doc.size)}
                          {doc.chunk_count > 0 && ` · ${doc.chunk_count} 个切片`}
                          {doc.doc_version && doc.doc_version !== '1' && (
                            <Tag theme="warning" variant="light" size="small" style={{ marginLeft: 4 }}>
                              v{doc.doc_version}
                            </Tag>
                          )}
                          {doc.error && <span style={{ color: 'var(--td-error-color)' }}> · {doc.error}</span>}
                        </div>
                      </div>
                      <Button
                        theme="default"
                        variant="text"
                        size="small"
                        icon={<BrowseIcon />}
                        onClick={() => openPreview(doc)}
                        title="预览原文"
                      />
                      <Button
                        theme="primary"
                        variant={doc.status === 'ready' ? 'outline' : 'base'}
                        size="small"
                        loading={isEmbedding}
                        icon={<Sparkles size={14} />}
                        onClick={() => handleEmbed(doc)}
                      >
                        {doc.status === 'ready' ? '重新向量化' : '向量化'}
                      </Button>
                      <Popconfirm content="确定删除该文档及其向量数据？" onConfirm={() => handleDelete(doc)}>
                        <Button theme="danger" variant="text" size="small" icon={<DeleteIcon />} />
                      </Popconfirm>
                    </div>
                  );
                })}
              </div>

              {docs.length > 0 && (
                <Button variant="text" icon={<RefreshIcon />} onClick={fetchDocs} size="small">
                  刷新状态
                </Button>
              )}
            </div>
          </TabPanel>

          {/* ============ 提示词设置 ============ */}
          <TabPanel value="prompt" label="回答提示词">
            <div className="py-4 space-y-4">
              {settings && (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                        自定义 RAG 系统提示词
                      </label>
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => setSettings({ ...settings, ragPrompt: defaultRagPrompt })}
                      >
                        恢复默认
                      </Button>
                    </div>
                    <p className="text-xs mb-2" style={{ color: 'var(--td-text-color-secondary)' }}>
                      LLM 回答问题时使用的系统提示词由你完全掌控。使用 <code style={{ backgroundColor: 'var(--td-bg-color-component)', padding: '1px 4px', borderRadius: 3 }}>{'{context}'}</code> 占位符标记知识库检索内容的插入位置；不写占位符时检索内容会自动附加在提示词末尾。
                    </p>
                    <Textarea
                      value={settings.ragPrompt}
                      onChange={(v) => setSettings({ ...settings, ragPrompt: String(v) })}
                      autosize={{ minRows: 10, maxRows: 24 }}
                      placeholder="在这里编写你自己的提示词..."
                    />
                  </div>
                  <Button theme="primary" icon={<SaveIcon />} loading={savingSettings} onClick={handleSaveSettings}>
                    保存提示词
                  </Button>
                </>
              )}
            </div>
          </TabPanel>

          {/* ============ Embedding 配置 ============ */}
          <TabPanel value="embedding" label="Embedding 配置">
            <div className="py-4 space-y-4 max-w-xl">
              {settings && (
                <>
                  <div
                    className="p-3 rounded-lg text-sm"
                    style={{ backgroundColor: 'var(--td-brand-color-light)', color: 'var(--td-brand-color)' }}
                  >
                    未配置 API 时使用内置本地向量（开箱即用，精度一般）。配置 OpenAI 兼容的 Embedding API 后检索效果更好，修改配置后需对文档重新向量化。
                    {/dashscope/i.test(settings.embeddingApiUrl || '') && (
                      <div className="mt-2" style={{ color: '#ed7b2f' }}>
                        ⚠️ 检测到通义千问（dashscope）：请选择 <b>text-embedding-v3</b>，勿用 OpenAI 的 text-embedding-3-small（dashscope 不支持，会 404）。
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
                      API 地址（OpenAI 兼容）
                    </label>
                    <Input
                      value={settings.embeddingApiUrl}
                      onChange={(v) => setSettings({ ...settings, embeddingApiUrl: String(v) })}
                      placeholder="例如 https://api.openai.com/v1 或 http://localhost:11434/v1（Ollama）"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
                      API Key
                    </label>
                    <Input
                      type="password"
                      value={settings.embeddingApiKey}
                      onChange={(v) => setSettings({ ...settings, embeddingApiKey: String(v) })}
                      placeholder="sk-..."
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
                      Embedding 模型
                    </label>
                    <Select
                      value={settings.embeddingModel || undefined}
                      onChange={(v: any) => setSettings({ ...settings, embeddingModel: String(v ?? '') })}
                      filterable
                      creatable
                      clearable
                      placeholder="选择或输入 Embedding 模型名"
                      style={{ width: '100%' }}
                    >
                      <Select.Option value="text-embedding-v3" label="text-embedding-v3（通义千问/dashscope·1024维·推荐）">text-embedding-v3（通义千问/dashscope·1024维·推荐）</Select.Option>
                      <Select.Option value="text-embedding-v2" label="text-embedding-v2（通义千问/dashscope·1536维）">text-embedding-v2（通义千问/dashscope·1536维）</Select.Option>
                      <Select.Option value="text-embedding-v1" label="text-embedding-v1（通义千问/dashscope·1536维）">text-embedding-v1（通义千问/dashscope·1536维）</Select.Option>
                      <Select.Option value="text-embedding-3-small" label="text-embedding-3-small（OpenAI·1536维）">text-embedding-3-small（OpenAI·1536维）</Select.Option>
                      <Select.Option value="text-embedding-3-large" label="text-embedding-3-large（OpenAI·3072维）">text-embedding-3-large（OpenAI·3072维）</Select.Option>
                      <Select.Option value="bge-m3" label="bge-m3（开源多语言·1024维）">bge-m3（开源多语言·1024维）</Select.Option>
                    </Select>
                    <p className="text-xs mt-1" style={{ color: 'var(--td-text-color-placeholder)' }}>
                      模型需与 Embedding API 匹配；维度不匹配时需对文档重新向量化。
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
                        检索条数 TopK
                      </label>
                      <InputNumber
                        value={settings.topK}
                        min={1}
                        max={20}
                        onChange={(v) => setSettings({ ...settings, topK: Number(v) })}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
                        切片长度
                      </label>
                      <InputNumber
                        value={settings.chunkSize}
                        min={100}
                        max={4000}
                        step={100}
                        onChange={(v) => setSettings({ ...settings, chunkSize: Number(v) })}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--td-text-color-primary)' }}>
                        切片重叠
                      </label>
                      <InputNumber
                        value={settings.chunkOverlap}
                        min={0}
                        max={1000}
                        step={50}
                        onChange={(v) => setSettings({ ...settings, chunkOverlap: Number(v) })}
                      />
                    </div>
                  </div>
                  <Button theme="primary" icon={<SaveIcon />} loading={savingSettings} onClick={handleSaveSettings}>
                    保存配置
                  </Button>
                </>
              )}
            </div>
          </TabPanel>

          {/* ============ 检索测试 ============ */}
          <TabPanel value="search" label="检索测试">
            <div className="py-4 space-y-4">
              <div className="flex gap-2">
                <Input
                  value={searchQuery}
                  onChange={(v) => setSearchQuery(String(v))}
                  placeholder="输入问题，测试知识库能检索到哪些内容"
                  onEnter={handleSearch}
                />
                <Button theme="primary" icon={<SearchIcon />} loading={searching} onClick={handleSearch}>
                  检索
                </Button>
              </div>
              {searched && searchResults.length === 0 && (
                <div className="text-center py-8 text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
                  未检索到相关内容（请确认已有文档完成向量化）
                </div>
              )}
              <div className="space-y-3">
                {searchResults.map((r, i) => (
                  <div
                    key={`${r.docId}-${r.chunkIndex}`}
                    className="p-4 rounded-lg"
                    style={{ backgroundColor: 'var(--td-bg-color-container)' }}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Tag theme="primary" variant="light" size="small">#{i + 1}</Tag>
                      <span className="text-xs font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                        {r.docName} · 切片 {r.chunkIndex + 1}
                      </span>
                      <Tag theme="success" variant="light" size="small">
                        相关度 {(r.score * 100).toFixed(1)}%
                      </Tag>
                    </div>
                    <p
                      className="text-sm whitespace-pre-wrap"
                      style={{ color: 'var(--td-text-color-secondary)', maxHeight: 150, overflow: 'auto' }}
                    >
                      {r.content}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </TabPanel>
        </Tabs>

        {/* 文档预览弹窗 */}
        <Dialog
          header={`文档预览：${previewDoc?.name || ''}`}
          visible={!!previewDoc}
          onClose={() => setPreviewDoc(null)}
          footer={false}
          width={680}
        >
          {previewLoading ? (
            <div className="text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>加载中...</div>
          ) : (
            <pre
              className="text-sm whitespace-pre-wrap break-words"
              style={{
                color: 'var(--td-text-color-secondary)',
                maxHeight: 480,
                overflow: 'auto',
                margin: 0,
                fontFamily: 'inherit',
              }}
            >
              {previewContent}
            </pre>
          )}
        </Dialog>
      </div>
    </div>
  );
}
