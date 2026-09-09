import { useState } from 'react';
import { Loading, Dialog } from 'tdesign-react';
import { ChatMarkdown } from '@tdesign-react/chat';
import { User, Bot, BookOpen, Copy, RefreshCw, Trash2 } from 'lucide-react';
import { Message, Model, PermissionRequest, ContentBlock, KbSource } from '../types';
import { ToolCallsCollapse } from './ToolCallsCollapse';
import { InlinePermissionCard } from './InlinePermissionCard';

interface ChatMessagesProps {
  messages: Message[];
  models: Model[];
  messagesEndRef: React.RefObject<HTMLDivElement>;
  // 内联权限确认相关
  permissionRequest?: PermissionRequest | null;
  onPermissionAllow?: () => void;
  onPermissionDeny?: () => void;
  // 消息操作
  onDeleteMessage?: (id: string) => void;
  onRegenerate?: (assistantMsg: Message) => void;
}

export function ChatMessages({ 
  messages, 
  models, 
  messagesEndRef,
  permissionRequest,
  onPermissionAllow,
  onPermissionDeny,
  onDeleteMessage,
  onRegenerate
}: ChatMessagesProps) {

  // 复制消息文本
  const handleCopy = (text: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  const formatModelName = (modelId: string) => {
    const model = models.find(m => m.modelId === modelId);
    const name = model?.name || modelId;
    return name
      .replace(/^(Claude|GPT|Gemini|Kimi|DeepSeek|Qwen|GLM)\s*/i, '')
      .replace(/-/g, ' ')
      .trim() || name;
  };

  // 引用来源弹窗（点击引用标签查看原文切片）
  const [activeSource, setActiveSource] = useState<KbSource | null>(null);

  // 渲染单个内容块
  const renderContentBlock = (block: ContentBlock, index: number, isStreaming?: boolean, isLast?: boolean) => {
    if (block.type === 'text') {
      return (
        <div 
          key={`text-${index}`}
          className="px-4 py-3 leading-relaxed break-words"
          style={{
            backgroundColor: 'var(--td-bg-color-component)',
            color: 'var(--td-text-color-primary)',
            borderRadius: '16px 16px 16px 4px'
          }}
        >
          <div className="chat-markdown">
            <ChatMarkdown content={block.text} />
          </div>
          {isStreaming && isLast && (
            <span 
              className="animate-cursor-blink ml-0.5"
              style={{ color: 'var(--td-brand-color)' }}
            >
              |
            </span>
          )}
        </div>
      );
    } else if (block.type === 'tool_use') {
      return (
        <ToolCallsCollapse
          key={`tool-${block.toolCall.id}`}
          toolCalls={[block.toolCall]}
          isStreaming={isStreaming && block.toolCall.status === 'running'}
        />
      );
    }
    return null;
  };

  // 渲染 assistant 消息内容
  const renderAssistantContent = (message: Message) => {
    // 优先使用 contentBlocks（按顺序排列）
    if (message.contentBlocks && message.contentBlocks.length > 0) {
      return message.contentBlocks.map((block, index) => 
        renderContentBlock(block, index, message.isStreaming, index === message.contentBlocks!.length - 1)
      );
    }
    
    // 兼容旧数据：先显示所有工具调用，再显示文本
    return (
      <>
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsCollapse
            toolCalls={message.toolCalls}
            isStreaming={message.isStreaming}
          />
        )}
        {message.content && (
          <div 
            className="px-4 py-3 leading-relaxed break-words"
            style={{
              backgroundColor: 'var(--td-bg-color-component)',
              color: 'var(--td-text-color-primary)',
              borderRadius: '16px 16px 16px 4px'
            }}
          >
            <div className="chat-markdown">
              <ChatMarkdown content={message.content} />
            </div>
            {message.isStreaming && (
              <span 
                className="animate-cursor-blink ml-0.5"
                style={{ color: 'var(--td-brand-color)' }}
              >
                |
              </span>
            )}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto">
      {messages.map(message => (
        <div 
          key={message.id} 
          className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
        >
          <div 
            className="w-9 h-9 flex items-center justify-center flex-shrink-0 rounded-full self-start"
            style={{
              backgroundColor: message.role === 'user' 
                ? 'var(--td-brand-color)' 
                : 'var(--td-bg-color-component)',
              color: message.role === 'user' 
                ? 'white' 
                : 'var(--td-text-color-primary)'
            }}
          >
            {message.role === 'user' ? <User size={18} /> : <Bot size={18} />}
          </div>
          <div 
            className={`group relative flex flex-col gap-2 max-w-[80%] ${message.role === 'user' ? 'items-end' : ''}`}
          >
            {message.role === 'assistant' && message.model && (
              <span 
                className="text-xs"
                style={{ color: 'var(--td-text-color-placeholder)' }}
              >
                {formatModelName(message.model)}
              </span>
            )}
            
            {/* 用户消息 */}
            {message.role === 'user' && (
              <div 
                className="px-4 py-3 leading-relaxed break-words"
                style={{
                  backgroundColor: 'var(--td-brand-color)',
                  color: 'white',
                  borderRadius: '16px 16px 4px 16px'
                }}
              >
                {message.content}
              </div>
            )}
            
            {/* 知识库检索来源 */}
            {message.role === 'assistant' && message.kbSources && message.kbSources.length > 0 && (
              <div 
                className="flex flex-wrap items-center gap-1.5 px-3 py-2 rounded-lg text-xs"
                style={{ 
                  backgroundColor: 'var(--td-brand-color-light)',
                  color: 'var(--td-brand-color)'
                }}
              >
                <BookOpen size={13} />
                <span className="font-medium">知识库引用：</span>
                {message.kbSources.map((src, i) => (
                  <span 
                    key={i}
                    className="px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80"
                    style={{ backgroundColor: 'var(--td-bg-color-container)' }}
                    title="点击查看原文切片"
                    onClick={() => setActiveSource(src)}
                  >
                    {src.docName} · 片段{src.chunkIndex + 1}（{(src.score * 100).toFixed(0)}%）
                  </span>
                ))}
              </div>
            )}
            
            {/* 助手消息 - 按顺序渲染内容块 */}
            {message.role === 'assistant' && renderAssistantContent(message)}
            
            {/* 思考中状态（没有任何内容时显示） */}
            {message.role === 'assistant' && message.isStreaming && 
             !message.content && 
             (!message.contentBlocks || message.contentBlocks.length === 0) && 
             (!message.toolCalls || message.toolCalls.length === 0) && (
              <div 
                className="flex items-center gap-2 px-3 py-2 rounded-lg"
                style={{ backgroundColor: 'var(--td-bg-color-component)' }}
              >
                <Loading size="small" />
                <span 
                  className="text-sm"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                >
                  思考中...
                </span>
              </div>
            )}

            {/* 消息操作：复制 / 重新生成 / 删除 */}
            <div
              className={`flex items-center gap-1 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity ${message.role === 'user' ? 'self-end' : 'self-start'}`}
            >
              <button
                type="button"
                title="复制"
                onClick={() => handleCopy(message.content)}
                className="p-1 rounded hover:bg-[var(--td-bg-color-component)]"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                <Copy size={13} />
              </button>
              {message.role === 'assistant' && !message.isStreaming && (
                <button
                  type="button"
                  title="重新生成"
                  onClick={() => onRegenerate?.(message)}
                  className="p-1 rounded hover:bg-[var(--td-bg-color-component)]"
                  style={{ color: 'var(--td-text-color-secondary)' }}
                >
                  <RefreshCw size={13} />
                </button>
              )}
              <button
                type="button"
                title="删除"
                onClick={() => onDeleteMessage?.(message.id)}
                className="p-1 rounded hover:bg-[var(--td-bg-color-component)]"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </div>
      ))}
      
      {/* 内联权限确认 - 横向简洁展示 */}
      {permissionRequest && onPermissionAllow && onPermissionDeny && (
        <div className="flex gap-3 ml-12">
          <InlinePermissionCard
            request={permissionRequest}
            onAllow={onPermissionAllow}
            onDeny={onPermissionDeny}
          />
        </div>
      )}
      
      <Dialog
        header={activeSource ? `引用原文：${activeSource.docName} · 片段${activeSource.chunkIndex + 1}` : ''}
        visible={!!activeSource}
        onClose={() => setActiveSource(null)}
        footer={false}
        width={640}
      >
        {activeSource ? (
          <div>
            <div className="mb-2 text-xs" style={{ color: 'var(--td-text-color-secondary)' }}>
              相关度 {(activeSource.score * 100).toFixed(1)}%
            </div>
            <pre
              className="text-sm whitespace-pre-wrap break-words"
              style={{
                color: 'var(--td-text-color-primary)',
                maxHeight: 460,
                overflow: 'auto',
                margin: 0,
                fontFamily: 'inherit',
              }}
            >
              {activeSource.content || '（该引用缺少原文缓存，请在知识库页检索测试中查看）'}
            </pre>
          </div>
        ) : null}
      </Dialog>
      <div ref={messagesEndRef} />
    </div>
  );
}
