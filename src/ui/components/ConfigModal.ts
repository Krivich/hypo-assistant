import { StorageAdapter } from '../../config/StorageAdapter.js';
import { ChatPanel } from './ChatPanel.js';

export class ConfigModal {
  constructor(
    private storage: StorageAdapter,
    private chatPanel: ChatPanel
  ) {}

  show(): void {
    const configRaw = localStorage.getItem('hypoAssistantConfig');
    let config = configRaw ? JSON.parse(configRaw) : {};

    // Миграция старой конфигурации (временно)
    if (config.apiKey !== undefined || config.apiEndpoint !== undefined || config.model !== undefined) {
      config = {
        llm: {
          apiKey: config.apiKey,
          apiEndpoint: config.apiEndpoint,
          model: config.model
        }
      };
    }

    const llm = config.llm || {};
    const ep = prompt('API Endpoint:', llm.apiEndpoint || 'https://openrouter.ai/api/v1/chat/completions') || llm.apiEndpoint;
    const key = prompt('API Key:') || llm.apiKey;
    const model = prompt('Model:', llm.model || 'tngtech/deepseek-r1t2-chimera:free') || llm.model;

    const newConfig = {
      llm: { apiEndpoint: ep, apiKey: key, model: model }
    };

    localStorage.setItem('hypoAssistantConfig', JSON.stringify(newConfig));
    this.chatPanel.addMessage('✅ Config saved.', 'assist');

    if (key && key !== llm.apiKey) {
      localStorage.removeItem('hypoAssistantSemanticIndex');
      this.chatPanel.addMessage('🔄 Semantic index will be rebuilt on next request.', 'assist');
    }
  }
}
