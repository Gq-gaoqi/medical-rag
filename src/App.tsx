import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useNavigate, useParams, useLocation } from 'react-router-dom';
import '@tdesign-react/chat/es/style/index.js';

import { useAgents } from './hooks/useAgents';
import { useTheme } from './hooks/useTheme';
import { useSessions } from './hooks/useSessions';
import { useModels } from './hooks/useModels';
import { useChat } from './hooks/useChat';
import { useLoginStatus } from './hooks/useLoginStatus';
import { PermissionMode, Message } from './types';

import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { LoginBanner } from './components/LoginBanner';
import { SettingsPage } from './components/SettingsPage';
import { ChatPage } from './pages/ChatPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { TriagePage } from './pages/TriagePage';

function App() {
  return (
    <Routes>
      <Route path="/" element={<AppContent />} />
      <Route path="/chat/:sessionId" element={<AppContent />} />
      <Route path="/settings" element={<AppContent />} />
      <Route path="/knowledge" element={<AppContent />} />
      <Route path="/triage" element={<AppContent />} />
    </Routes>
  );
}

function AppContent() {
  const navigate = useNavigate();
  const { sessionId: urlSessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const isSettingsPage = location.pathname === '/settings';
  const isKnowledgePage = location.pathname === '/knowledge';
  const isTriagePage = location.pathname === '/triage';
  
  // 知识库问答开关（持久化到 localStorage）
  const [useKb, setUseKb] = useState(() => localStorage.getItem('useKb') !== 'false');
  const handleUseKbChange = useCallback((value: boolean) => {
    setUseKb(value);
    localStorage.setItem('useKb', String(value));
  }, []);
  
  // Hooks
  const { theme, toggleTheme } = useTheme();
  const { agents, addAgent, updateAgent, deleteAgent, getAgent } = useAgents();
  const { models, selectedModel, setSelectedModel, fetchModels } = useModels();
  const {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    currentSession,
    sessionModels,
    fetchSessions,
    deleteSession,
    updateSessionModel,
    addSession,
    updateSession,
    updateSessionMessages,
  } = useSessions();

  // 聊天 Hook
  const {
    isLoading,
    inputValue,
    setInputValue,
    permissionRequest,
    sendMessage,
    handleStop,
    handlePermissionAllow,
    handlePermissionDeny,
  } = useChat({
    currentSession,
    currentSessionId,
    selectedModel,
    useKb,
    getAgent,
    addSession,
    updateSession,
    updateSessionMessages,
    updateSessionModel,
    setCurrentSessionId,
    setSessions,
  });

  // 获取当前会话的 Agent
  const currentAgent = currentSession?.agentId ? getAgent(currentSession.agentId) : getAgent('default');

  // 从 URL 同步 sessionId
  useEffect(() => {
    if (urlSessionId && urlSessionId !== currentSessionId) {
      setCurrentSessionId(urlSessionId);
    } else if (!urlSessionId && !isSettingsPage && !isKnowledgePage && currentSessionId) {
      setCurrentSessionId(null);
    }
  }, [urlSessionId, isSettingsPage, isKnowledgePage, isTriagePage, currentSessionId, setCurrentSessionId]);

  // 当切换会话时，恢复该会话的模型选择
  useEffect(() => {
    if (currentSessionId && sessionModels[currentSessionId]) {
      setSelectedModel(sessionModels[currentSessionId]);
    } else if (currentSession) {
      setSelectedModel(currentSession.model);
    }
  }, [currentSessionId, sessionModels, currentSession, setSelectedModel]);

  // 初始加载会话列表
  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // 更新当前会话的模型
  const updateCurrentSessionModel = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    if (currentSessionId) {
      updateSessionModel(currentSessionId, modelId);
    }
  }, [currentSessionId, updateSessionModel, setSelectedModel]);

  // 删除会话处理
  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const navigateTo = await deleteSession(sessionId);
    if (navigateTo) {
      navigate(navigateTo);
    }
  }, [deleteSession, navigate]);

  // 侧边栏事件处理
  const handleNewChat = useCallback(() => {
    setCurrentSessionId(null);
    navigate('/');
  }, [navigate, setCurrentSessionId]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setCurrentSessionId(sessionId);
    navigate(`/chat/${sessionId}`);
  }, [navigate, setCurrentSessionId]);

  const handleOpenSettings = useCallback(() => {
    navigate('/settings');
  }, [navigate]);

  const handleOpenKnowledge = useCallback(() => {
    navigate('/knowledge');
  }, [navigate]);

  const handleOpenTriage = useCallback(() => {
    navigate('/triage');
  }, [navigate]);

  // 删除单条消息
  const handleDeleteMessage = useCallback(async (messageId: string) => {
    try {
      await fetch(`/api/messages/${messageId}`, { method: 'DELETE' });
    } catch { /* 忽略网络错误，本地状态仍更新 */ }
    if (currentSessionId) {
      updateSessionMessages(currentSessionId, (msgs) => msgs.filter(m => m.id !== messageId));
    }
  }, [currentSessionId, updateSessionMessages]);

  // 重新生成助手回答：删除该助手消息及其前一条用户消息，再重新发送用户问题
  const handleRegenerate = useCallback(async (assistantMsg: Message) => {
    if (!currentSession) return;
    const msgs = currentSession.messages;
    const idx = msgs.findIndex(m => m.id === assistantMsg.id);
    const prevUser = idx > 0 ? msgs[idx - 1] : undefined;
    const userText = prevUser?.role === 'user' ? prevUser.content : '';
    if (!userText) return;

    const idsToDelete = [assistantMsg.id, ...(prevUser ? [prevUser.id] : [])];
    await Promise.all(
      idsToDelete.map(id => fetch(`/api/messages/${id}`, { method: 'DELETE' }).catch(() => {}))
    );
    updateSessionMessages(currentSession.id, (m) => m.filter(x => !idsToDelete.includes(x.id)));
    sendMessage(userText);
  }, [currentSession, sendMessage, updateSessionMessages]);

  // Sidebar 状态
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  // 权限模式状态
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');

  // 就绪态：未就绪时展示引导条（设置页自身已含登录区，无需重复）
  // ready = CodeBuddy 已登录 或 OpenAI 兼容模式已配 Key
  const { ready, checking, check: checkLogin, provider } = useLoginStatus();
  useEffect(() => {
    // 从设置页返回（或离开设置页）时刷新一次就绪态
    if (!isSettingsPage) checkLogin();
  }, [isSettingsPage, checkLogin]);

  return (
    <div 
      className="flex h-screen w-screen"
      style={{ backgroundColor: 'var(--td-bg-color-page)' }}
    >
      {/* 侧边栏 */}
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        isSettingsPage={isSettingsPage}
        isKnowledgePage={isKnowledgePage}
        isTriagePage={isTriagePage}
        sidebarOpen={sidebarOpen}
        agents={agents}
        getAgent={getAgent}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onOpenSettings={handleOpenSettings}
        onOpenKnowledge={handleOpenKnowledge}
        onOpenTriage={handleOpenTriage}
      />

      {/* 主内容区 */}
      <main 
        className="flex-1 flex flex-col min-w-0"
        style={{ backgroundColor: 'var(--td-bg-color-page)' }}
      >
        {/* 顶部栏 */}
        <Header
          isSettingsPage={isSettingsPage}
          sidebarOpen={sidebarOpen}
          theme={theme}
          currentSession={currentSession}
          currentAgent={currentAgent}
          models={models}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          onToggleTheme={toggleTheme}
          onRefreshModels={fetchModels}
        />

        {/* 引导条：未就绪且非设置页时展示 */}
        {!isSettingsPage && !checking && !ready && (
          <LoginBanner onGoSettings={handleOpenSettings} provider={provider} />
        )}

        {/* 设置页面 / 知识库页面 / 聊天页面 */}
        {isSettingsPage ? (
          <SettingsPage
            agents={agents}
            onAdd={addAgent}
            onUpdate={updateAgent}
            onDelete={deleteAgent}
          />
        ) : isKnowledgePage ? (
          <KnowledgePage />
        ) : isTriagePage ? (
          <TriagePage />
        ) : (
          <ChatPage
            currentSession={currentSession}
            models={models}
            selectedModel={selectedModel}
            agents={agents}
            isLoading={isLoading}
            inputValue={inputValue}
            permissionRequest={permissionRequest}
            permissionMode={permissionMode}
            useKb={useKb}
            onUseKbChange={handleUseKbChange}
            onSendMessage={sendMessage}
            onStop={handleStop}
            onInputChange={setInputValue}
            onModelChange={updateCurrentSessionModel}
            onPermissionAllow={handlePermissionAllow}
            onPermissionDeny={handlePermissionDeny}
            onPermissionModeChange={setPermissionMode}
            onDeleteMessage={handleDeleteMessage}
            onRegenerate={handleRegenerate}
          />
        )}
      </main>
    </div>
  );
}

export default App;
