/**
 * 配置面板组件
 */
import React, { useState, useEffect } from 'react';
import { ConfigData } from '../types';
import { configApi, getErrorMessage } from '../services/api';

interface ConfigPanelProps {
  config: ConfigData;
  onConfigChange: (config: ConfigData) => void;
}

const ConfigPanel: React.FC<ConfigPanelProps> = ({ config, onConfigChange }) => {
  const [localConfig, setLocalConfig] = useState<ConfigData>(config);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadConfig = React.useCallback(async () => {
    try {
      const response = await configApi.loadConfig();
      if (response.data) {
        setLocalConfig(response.data);
        onConfigChange(response.data);
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error, '加载配置失败') });
    }
  }, [onConfigChange]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    try {
      setLoading(true);
      const response = await configApi.saveConfig(localConfig);

      if (response.data.success) {
        onConfigChange(localConfig);
        setMessage({ type: 'success', text: '配置保存成功！' });
        setTimeout(() => setMessage(null), 3000);
      } else {
        setMessage({ type: 'error', text: response.data.message || '配置保存失败' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: getErrorMessage(error, '配置保存失败') });
    } finally {
      setLoading(false);
    }
  };

  const handleGetModels = async () => {
    if (!localConfig.api_key) {
      setMessage({ type: 'error', text: '请先输入API Key' });
      return;
    }

    try {
      setLoading(true);
      const response = await configApi.getModels(localConfig);
      
      if (response.data.success) {
        setModels(response.data.models);
        // 如果当前选中的模型不在新的模型列表中，则选择第一个可用模型
        if (response.data.models.length > 0 && !response.data.models.includes(localConfig.model_name)) {
          setLocalConfig({ ...localConfig, model_name: response.data.models[0] });
        }
        setMessage({ type: 'success', text: `获取到 ${response.data.models.length} 个模型` });
        setTimeout(() => setMessage(null), 3000);
      } else {
        setMessage({ type: 'error', text: response.data.message });
      }
    } catch (error) {
        setMessage({ type: 'error', text: getErrorMessage(error, '获取模型列表失败') });
      } finally {
        setLoading(false);
      }
  };

  return (
    <div className="bg-white shadow-sm border-r border-slate-200 w-80 p-6 overflow-y-auto">
      <div className="space-y-6">
        {/* 品牌标题 */}
        <div className="flex items-center gap-3 pb-5 border-b border-slate-200">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-900 shadow-sm">
            <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3v4a1 1 0 0 0 1 1h4" />
              <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
              <path d="M9 13h6" stroke="#60a5fa" />
              <path d="M9 17h4" stroke="#60a5fa" />
            </svg>
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-slate-900 leading-tight">AI写标书助手</h1>
            <p className="text-xs text-slate-500 mt-0.5">智能投标文件生成</p>
          </div>
        </div>

        {/* 基本配置 */}
        <div>
          <h2 className="text-lg font-medium text-slate-900 mb-4">⚙️ 基本配置</h2>
          
          <div className="space-y-4">
            <div>
              <label htmlFor="api_key" className="block text-sm font-medium text-slate-700">
                OpenAI API Key
              </label>
              <input
                type="password"
                id="api_key"
                value={localConfig.api_key}
                onChange={(e) => setLocalConfig({ ...localConfig, api_key: e.target.value })}
                className="mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                placeholder="输入你的OpenAI API密钥"
              />
            </div>

            <div>
              <label htmlFor="base_url" className="block text-sm font-medium text-slate-700">
                Base URL (可选)
              </label>
              <input
                type="text"
                id="base_url"
                value={localConfig.base_url || ''}
                onChange={(e) => setLocalConfig({ ...localConfig, base_url: e.target.value })}
                className="mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                placeholder="如果使用代理或其他服务，请输入base URL"
              />
            </div>
          </div>
        </div>

        {/* 模型配置 */}
        <div>
          <h3 className="text-base font-medium text-slate-900 mb-3">🤖 模型配置</h3>
          
          <button
            onClick={handleGetModels}
            disabled={loading}
            className="w-full mb-3 inline-flex justify-center items-center px-4 py-2.5 border border-transparent text-sm font-medium rounded-lg text-white bg-primary-600 hover:bg-primary-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:bg-slate-400"
          >
            {loading ? '获取中...' : '🔄 获取可用模型'}
          </button>

          <div>
            <label htmlFor="model_name" className="block text-sm font-medium text-slate-700">
              模型名称
            </label>
            {models.length > 0 ? (
              <select
                id="model_name"
                value={localConfig.model_name}
                onChange={(e) => {
                  setLocalConfig({ ...localConfig, model_name: e.target.value });
                }}
                className="mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
              >
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                id="model_name"
                value={localConfig.model_name}
                onChange={(e) => setLocalConfig({ ...localConfig, model_name: e.target.value })}
                className="mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-primary-500 focus:ring-primary-500 sm:text-sm"
                placeholder="输入要使用的模型名称"
              />
            )}
          </div>
        </div>

        {/* 保存按钮 */}
        <button
          onClick={handleSave}
          disabled={loading}
          className="w-full inline-flex justify-center items-center px-4 py-2.5 border border-transparent text-sm font-medium rounded-lg text-white bg-primary-600 hover:bg-primary-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:bg-slate-400"
        >
          {loading ? '保存中...' : '💾 保存配置'}
        </button>

        {/* 消息提示 */}
        {message && (
          <div className={`p-3 rounded-md text-sm ${
            message.type === 'success' 
              ? 'bg-green-100 text-green-700 border border-green-200' 
              : 'bg-red-100 text-red-700 border border-red-200'
          }`}>
            {message.text}
          </div>
        )}

        {/* 使用说明 */}
        <div className="border-t border-slate-200 pt-4">
          <h3 className="text-sm font-medium text-slate-900 mb-2">📋 使用说明</h3>
          <div className="text-sm text-slate-600 space-y-1">
            <p>1. 配置API密钥和Base URL</p>
            <p>2. 选择或输入模型名称</p>
            <p>3. 按步骤完成标书编写流程</p>
          </div>
        </div>

        {/* 底部说明 */}
        <div className="border-t border-slate-200 pt-4">
          <p className="text-center text-xs text-slate-400 leading-relaxed">
            本地运行 · 配置与文档仅保存在本机
          </p>
        </div>
      </div>
    </div>
  );
};

export default ConfigPanel;
