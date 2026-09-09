import { useState, useEffect } from 'react';
import { Button, Tooltip, Input } from 'tdesign-react';
import { AddIcon, DeleteIcon, SettingIcon, BookIcon, SearchIcon, HeartIcon } from 'tdesign-icons-react';
import { Bot } from 'lucide-react';
import { APP_CONFIG } from '../config';
import { Session, Agent } from '../types';
import { ICON_MAP } from '../utils/iconMap';
import { safeJsonOrNull } from '../utils/api';

interface SidebarProps {
  sessions: Session[];
  currentSessionId: string | null;
  isSettingsPage: boolean;
  isKnowledgePage: boolean;
  sidebarOpen: boolean;
  agents: Agent[];
  getAgent: (id: string) => Agent | undefined;
  onNewChat: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenSettings: () => void;
  onOpenKnowledge: () => void;
  onOpenTriage: () => void;
  isTriagePage?: boolean;
}

interface SearchHit {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  session_title: string;
}

export function Sidebar({
  sessions,
  currentSessionId,
  isSettingsPage,
  isKnowledgePage,
  isTriagePage,
  sidebarOpen,
  agents,
  getAgent,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onOpenSettings,
  onOpenKnowledge,
  onOpenTriage,
}: SidebarProps) {
  // 历史消息搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await safeJsonOrNull<{ results?: SearchHit[] }>(
          `/api/search?q=${encodeURIComponent(q)}`,
        );
        setSearchHits(data?.results || []);
      } catch {
        setSearchHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const isSearching = searchQuery.trim().length > 0;

  const handlePickHit = (hit: SearchHit) => {
    onSelectSession(hit.session_id);
    setSearchQuery('');
    setSearchHits([]);
  };

  return (
    <aside 
      className="flex flex-col flex-shrink-0 transition-all duration-300 overflow-hidden"
      style={{ 
        width: sidebarOpen ? 260 : 0,
        backgroundColor: 'var(--td-bg-color-container)'
      }}
    >
      {/* Logo */}
      <div className="h-14 px-4 flex items-center flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div 
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: 'var(--td-brand-color)' }}
          >
            <span className="text-white text-sm font-bold">{APP_CONFIG.nameInitial}</span>
          </div>
          <span 
            className="text-lg font-semibold"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            {APP_CONFIG.name}
          </span>
        </div>
      </div>

      {/* 新对话按钮 */}
      <div className="p-3">
        <Button 
          icon={<AddIcon />}
          onClick={onNewChat}
          block
          variant="outline"
        >
          新对话
        </Button>
      </div>

      {/* 历史搜索 */}
      <div className="px-3 pb-2">
        <Input
          value={searchQuery}
          onChange={(v) => setSearchQuery(String(v))}
          placeholder="搜索历史消息"
          prefixIcon={<SearchIcon />}
          clearable
          onClear={() => { setSearchQuery(''); setSearchHits([]); }}
        />
      </div>

      {/* 会话列表 / 搜索结果 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {isSearching ? (
          searchHits.length === 0 ? (
            <div className="text-center py-8 text-sm" style={{ color: 'var(--td-text-color-placeholder)' }}>
              {searching ? '搜索中...' : '没有匹配的消息'}
            </div>
          ) : (
            searchHits.map(hit => (
              <div
                key={hit.id}
                className="px-3 py-2.5 rounded-lg cursor-pointer transition-colors duration-200"
                style={{ color: 'var(--td-text-color-secondary)' }}
                onClick={() => handlePickHit(hit)}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--td-bg-color-component-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs truncate" style={{ color: 'var(--td-brand-color)' }}>
                    {hit.session_title}
                  </span>
                  <span className="text-[10px] px-1 rounded" style={{ backgroundColor: 'var(--td-bg-color-component)' }}>
                    {hit.role === 'user' ? '我' : 'AI'}
                  </span>
                </div>
                <div className="text-xs truncate">{hit.content}</div>
              </div>
            ))
          )
        ) : (
          sessions.map(session => {
          const sessionAgent = session.agentId ? getAgent(session.agentId) : getAgent('default');
          const AgentIcon = ICON_MAP[sessionAgent?.icon || 'Bot'] || Bot;
          return (
            <div 
              key={session.id}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer transition-colors duration-200 group"
              style={{
                backgroundColor: session.id === currentSessionId && !isSettingsPage
                  ? 'var(--td-brand-color-light)' 
                  : 'transparent',
                color: session.id === currentSessionId && !isSettingsPage
                  ? 'var(--td-brand-color)' 
                  : 'var(--td-text-color-secondary)'
              }}
              onClick={() => onSelectSession(session.id)}
              onMouseEnter={(e) => {
                if (session.id !== currentSessionId || isSettingsPage) {
                  e.currentTarget.style.backgroundColor = 'var(--td-bg-color-component-hover)';
                }
              }}
              onMouseLeave={(e) => {
                if (session.id !== currentSessionId || isSettingsPage) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <div 
                className="flex-shrink-0 w-5 h-5 rounded flex items-center justify-center"
                style={{ backgroundColor: sessionAgent?.color || 'var(--td-brand-color)' }}
              >
                <AgentIcon size={12} color="white" />
              </div>
              <span className="flex-1 truncate text-sm">{session.title}</span>
              <Tooltip content="删除会话">
                <Button
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  variant="text"
                  shape="circle"
                  size="medium"
                  icon={<DeleteIcon />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteSession(session.id);
                  }}
                />
              </Tooltip>
            </div>
          );
        })
        )}
      </div>
      
      {/* 底部按钮 */}
      <div 
        className="p-3 border-t flex-shrink-0 space-y-1"
        style={{ borderColor: 'var(--td-component-border)' }}
      >
        <Button 
          icon={<HeartIcon />}
          onClick={onOpenTriage}
          block
          variant={isTriagePage ? 'outline' : 'text'}
          theme={isTriagePage ? 'primary' : 'default'}
        >
          智能导诊
        </Button>
        <Button 
          icon={<BookIcon />}
          onClick={onOpenKnowledge}
          block
          variant={isKnowledgePage ? 'outline' : 'text'}
          theme={isKnowledgePage ? 'primary' : 'default'}
        >
          知识库
        </Button>
        <Button 
          icon={<SettingIcon />}
          onClick={onOpenSettings}
          block
          variant={isSettingsPage ? 'outline' : 'text'}
          theme={isSettingsPage ? 'primary' : 'default'}
        >
          设置
        </Button>
      </div>
    </aside>
  );
}
