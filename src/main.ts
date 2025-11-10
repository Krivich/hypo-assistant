// ТЕЗИС: main.ts — единственный модуль с глобальной оркестрацией. Все зависимости передаются явно.
// ТЕЗИС: Библиотека инициализируется автоматически при подключении скрипта.

import { AppConfig } from './config/AppConfig.js';
import { StorageAdapter } from './config/StorageAdapter.js';
import { LLMClient } from './llm/LLMClient.js';
import { HypoAssistantEngine } from './core/Engine.js';
import { HypoAssistantUI } from './ui/UI.js';
import { PatchManager } from './core/PatchManager.js';
import type { StoredPatch } from './types.js';

(async () => {
    'use strict';
    // ТЕЗИС: Библиотека инициализируется автоматически при подключении скрипта.
    // ТЕЗИС: Защита от двойной инициализации при document.write.
    if (document.getElementById('hypo-assistant-core')) {
        console.warn('[HypoAssistant] Already initialized. Skipping.');
        return;
    }

    const config = new AppConfig();
    await config.init();
    const storage = new StorageAdapter();
    const llm = new LLMClient(config, storage);
    const engine = new HypoAssistantEngine(config, storage, llm);

    // Применяем ТОЛЬКО включённые патчи при загрузке
    const savedPatches = storage.getPatches();
    const enabledPatches = savedPatches.filter(p => p.enabled);
    if (enabledPatches.length > 0) {
        PatchManager.applyToolCalls(enabledPatches.map(p => p.toolCall));
    }

    const ui = new HypoAssistantUI(
        async (query, signal) => await engine.run(query, signal),
        storage
    );

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ui.show());
    } else {
        ui.show();
    }
})();