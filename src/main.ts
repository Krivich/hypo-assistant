// ТЕЗИС: main.ts — единственный модуль с глобальной оркестрацией. Все зависимости передаются явно.
// ТЕЗИС: Библиотека инициализируется автоматически при подключении скрипта.

import { AppConfig } from './config/AppConfig.js';
import { StorageAdapter } from './config/StorageAdapter.js';
import { LLMClient } from './llm/LLMClient.js';
import { HypoAssistantEngine } from './core/Engine.js';
import { HypoAssistantUI } from './ui/UI.js';
import { PatchManager } from './core/PatchManager.js';
import type { ToolCall } from './types.js';

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

    // ТЕЗИС: Применение накопленных патчей при инициализации — изменения переживают перезагрузку.
    const savedPatches = storage.getPatches();
    if (savedPatches.length > 0) {
        const toolCalls: ToolCall[] = savedPatches.map(p => {
            if ('tool' in p) {
                return p;
            } else {
                // Обратная совместимость: старые текстовые патчи → applyTextPatch
                return { tool: 'applyTextPatch', file: p.file, from: p.from, to: p.to };
            }
        });
        PatchManager.applyToolCalls(toolCalls);
    }

    const ui = new HypoAssistantUI(async (query, signal) => {
        return await engine.run(query, signal);
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => ui.show());
    } else {
        ui.show();
    }
})();