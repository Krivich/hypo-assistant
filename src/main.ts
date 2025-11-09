// ТЕЗИС: main.ts — единственный модуль с глобальной оркестрацией. Все зависимости передаются явно.
// ТЕЗИС: Библиотека инициализируется автоматически при подключении скрипта.

import { AppConfig } from './config/AppConfig.js';
import { StorageAdapter } from './config/StorageAdapter.js';
import { LLMClient } from './llm/LLMClient.js';
import { HypoAssistantEngine } from './core/Engine.js';
import { HypoAssistantUI } from './ui/UI.js';

(async () => {
  'use strict';

  const config = new AppConfig();
  await config.init();
  const storage = new StorageAdapter();
  const llm = new LLMClient(config, storage);
  const engine = new HypoAssistantEngine(config, storage, llm);

  const ui = new HypoAssistantUI(async (query, signal) => {
    return await engine.run(query, signal);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ui.show());
  } else {
    ui.show();
  }
})();
