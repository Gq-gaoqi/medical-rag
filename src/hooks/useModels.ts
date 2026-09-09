import { useState, useEffect, useCallback } from 'react';
import { Model } from '../types';
import { safeJsonOrNull } from '../utils/api';

const STORAGE_KEY = 'defaultModel';

export function useModels() {
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY) || '';
  });

  const fetchModels = useCallback(async () => {
    try {
      const data = await safeJsonOrNull<{ models?: Model[]; defaultModel?: string }>('/api/models');
      if (!data) return;
      const list = data.models || [];
      setModels(list);
      if (list.length > 0 && !selectedModel) {
        const savedDefault = localStorage.getItem(STORAGE_KEY);
        const modelToUse = savedDefault && list.some((m: Model) => m.modelId === savedDefault)
          ? savedDefault
          : (data.defaultModel || list[0].modelId);
        setSelectedModel(modelToUse);
        localStorage.setItem(STORAGE_KEY, modelToUse);
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  }, [selectedModel]);

  // 初始加载
  useEffect(() => {
    fetchModels();
  }, []);

  return {
    models,
    selectedModel,
    setSelectedModel,
    fetchModels,
  };
}
