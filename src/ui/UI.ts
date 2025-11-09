// ТЕЗИС: UI создаёт свой DOM самостоятельно — библиотека полностью self-contained.
// ТЕЗИС: UI не содержит бизнес-логики — только отображение и маршрутиза

// ТЕЗИС: UI не содержит бизнес-логики — только отображение и маршрутизация событий.

import {PatchManager} from "../core/PatchManager";
import {PatchResult} from "../types";

export class HypoAssistantUI {
    private panel: HTMLElement | null = null;
    private abortController: AbortController | null = null;

    constructor(private onUserRequest: (query: string, signal: AbortSignal) => Promise<PatchResult>) {
    }

    private getTemplate(): string {
        return `
    <!-- Floating button (collapsed state) -->
    <div id="hypo-toggle" style="
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 56px;
      height: 56px;
      background: #6c63ff;
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      font-size: 24px;
      line-height: 1;
      font-family: sans-serif;
    ">🦛</div>

    <!-- Full panel (hidden by default) -->
    <div id="hypo-panel" style="
      display: none;
      position: fixed;
      right: 0;
      top: 0;
      width: 100vw;
      height: 100vh;
      max-width: 360px;
      background: #1e1e1e;
      color: #e0e0e0;
      font-family: monospace;
      z-index: 10000;
      box-shadow: -2px 0 10px rgba(0,0,0,0.5);
      display: none;
      flex-direction: column;
    ">
      <div style="padding: 10px; background: #2d2d2d; display: flex; justify-content: space-between; align-items: center;">
        <div style="font-weight: bold;">🦛 HypoAssistant v1.1</div>
        <button id="hypo-collapse" style="
          background: #555;
          color: white;
          border: none;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 14px;
        ">✕</button>
      </div>
      <div id="hypo-chat" style="flex: 1; overflow-y: auto; padding: 10px; font-size: 13px;"></div>
      <div style="display: flex; padding: 10px; background: #252526;">
        <input type="text" placeholder="Describe change..." id="hypo-input-field" style="flex: 1; background: #333; color: white; border: none; padding: 8px; border-radius: 3px;">
        <button id="hypo-send" style="background: #007acc; color: white; border: none; padding: 8px 12px; margin-left: 8px; border-radius: 3px; cursor: pointer;">Send</button>
      </div>
      <div style="padding: 10px; display: flex; gap: 6px;">
        <button id="hypo-export" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">Export HTML</button>
        <button id="hypo-settings" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">⚙️ Settings</button>
        <button id="hypo-reload" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">🔄 Reload</button>
      </div>
    </div>
  `;
    }

    public show(): void {
        if (this.panel) return;

        this.panel = document.createElement('div');
        this.panel.id = 'hypo-assistant-core';
        this.panel.innerHTML = this.getTemplate();
        document.body.appendChild(this.panel);

        const toggleBtn = document.getElementById('hypo-toggle')!;
        const panel = document.getElementById('hypo-panel')!;
        const collapseBtn = document.getElementById('hypo-collapse')!;

        // Toggle panel
        toggleBtn.onclick = () => {
            toggleBtn.style.display = 'none';
            panel.style.display = 'flex';
        };

        // Collapse panel
        collapseBtn.onclick = () => {
            panel.style.display = 'none';
            toggleBtn.style.display = 'flex';
        };

        const chat = document.getElementById('hypo-chat')!;
        const input = document.getElementById('hypo-input-field') as HTMLInputElement;
        const send = document.getElementById('hypo-send')!;
        const exportBtn = document.getElementById('hypo-export')!;
        const settings = document.getElementById('hypo-settings')!;
        const reload = document.getElementById('hypo-reload')!;

        const addMsg = (text: string, cls: string): void => {
            const el = document.createElement('div');
            el.className = `msg ${cls}`;
            el.textContent = text;
            chat.appendChild(el);
            chat.scrollTop = chat.scrollHeight;
        };

        send.onclick = async () => {
            const query = input.value.trim();
            if (!query) return;
            input.value = '';
            addMsg(query, 'user');

            // Отменяем предыдущий запрос
            this.abortController?.abort();
            this.abortController = new AbortController();

            const configKey = 'hypoAssistantConfig';
            const configRaw = localStorage.getItem(configKey);
            const config = configRaw ? JSON.parse(configRaw) : {};
            if (!config.apiKey) {
                addMsg('⚠️ Set API key in ⚙️', 'assist');
                return;
            }

            try {
                const res = await this.onUserRequest(query, this.abortController.signal);
                addMsg(res.message, 'assist');
                if (confirm('Apply patch?')) {
                    const patches = JSON.parse(localStorage.getItem('hypoAssistantPatches') || '[]');
                    localStorage.setItem('hypoAssistantPatches', JSON.stringify([...patches, ...res.patches]));

                    // ТЕЗИС: Применение изменений через безопасные тулы, без перезапуска скриптов
                    PatchManager.applyToolCalls(res.patches);

                    addMsg('✅ Applied.', 'assist');
                }
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    addMsg(`❌ ${(err as Error).message}`, 'assist');
                }
            }
        };

        exportBtn.onclick = () => {
            const blob = new Blob([document.documentElement.outerHTML], {type: 'text/html'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'hypo-patched-app.html';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };

        reload.onclick = () => location.reload();

        settings.onclick = () => {
            const currentConfigRaw = localStorage.getItem('hypoAssistantConfig');
            const currentConfig = currentConfigRaw ? JSON.parse(currentConfigRaw) : {};

            const currentLlm = currentConfig.llm || {};
            const ep = prompt('API Endpoint:', currentLlm.apiEndpoint || 'https://openrouter.ai/api/v1/chat/completions') || currentLlm.apiEndpoint;
            const key = prompt('API Key:') || currentLlm.apiKey;
            const model = prompt('Model:', currentLlm.model || 'qwen/qwen3-coder:free') || currentLlm.model;

            const newConfig = {
                ...currentConfig,
                llm: {
                    ...currentLlm,
                    apiEndpoint: ep,
                    apiKey: key,
                    model: model
                }
            };

            localStorage.setItem('hypoAssistantConfig', JSON.stringify(newConfig));
            addMsg('✅ Config saved.', 'assist');

            // Триггер сброса индекса при смене ключа
            if (key && key !== currentLlm.apiKey) {
                localStorage.removeItem('hypoAssistantSemanticIndex');
                addMsg('🔄 Semantic index will be rebuilt on next request.', 'assist');
            }
        };
    }
}
