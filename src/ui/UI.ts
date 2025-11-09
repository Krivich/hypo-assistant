// ТЕЗИС: UI создаёт свой DOM самостоятельно — библиотека полностью self-contained.
// ТЕЗИС: UI не содержит бизнес-логики — только отображение и маршрутиза

// ТЕЗИС: UI не содержит бизнес-логики — только отображение и маршрутизация событий.

import type { PatchResult } from '../core/Engine';

export class HypoAssistantUI {
  private panel: HTMLElement | null = null;
  private abortController: AbortController | null = null;

  constructor(private onUserRequest: (query: string, signal: AbortSignal) => Promise<PatchResult>) {}

  private getTemplate(): string {
    return `
      <style>
        #hypo-panel { position: fixed; right: 0; top: 0; width: 360px; height: 100vh;
          background: #1e1e1e; color: #e0e0e0; font-family: monospace; z-index: 10000;
          box-shadow: -2px 0 10px rgba(0,0,0,0.5); display: flex; flex-direction: column; }
        #hypo-header { padding: 10px; background: #2d2d2d; font-weight: bold; }
        #hypo-chat { flex: 1; overflow-y: auto; padding: 10px; font-size: 13px; }
        .msg { margin: 8px 0; white-space: pre-wrap; }
        .user { color: #4caf50; }
        .assist { color: #2196f3; }
        #hypo-input { display: flex; padding: 10px; background: #252526; }
        #hypo-input input { flex: 1; background: #333; color: white; border: none; padding: 8px; border-radius: 3px; }
        #hypo-input button { background: #007acc; color: white; border: none; padding: 8px 12px; margin-left: 8px; border-radius: 3px; cursor: pointer; }
        #hypo-actions { padding: 10px; display: flex; gap: 6px; }
        #hypo-actions button { flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
      </style>
      <div id="hypo-panel">
        <div id="hypo-header">🦛 HypoAssistant v1.1</div>
        <div id="hypo-chat"></div>
        <div id="hypo-input">
          <input type="text" placeholder="Describe change..." id="hypo-input-field">
          <button id="hypo-send">Send</button>
        </div>
        <div id="hypo-actions">
          <button id="hypo-export">Export HTML</button>
          <button id="hypo-settings">⚙️ Settings</button>
          <button id="hypo-reload">🔄 Reload</button>
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
          // Применяем патч
          const patches = JSON.parse(localStorage.getItem('hypoAssistantPatches') || '[]');
          localStorage.setItem('hypoAssistantPatches', JSON.stringify([...patches, ...res.patches]));

          const originalsRaw = localStorage.getItem('hypoAssistantOriginals');
          if (originalsRaw) {
            const originals = JSON.parse(originalsRaw);
            const patched = (await import('../core/PatchManager.js')).PatchManager.applyPatches(originals, [...patches, ...res.patches]);
            (await import('../core/PatchManager.js')).PatchManager.injectPatchedSources(patched);
            addMsg('✅ Applied. Page reloaded.', 'assist');
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          addMsg(`❌ ${(err as Error).message}`, 'assist');
        }
      }
    };

    exportBtn.onclick = () => {
      const blob = new Blob([document.documentElement.outerHTML], { type: 'text/html' });
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
      const ep = prompt('API Endpoint:', currentConfig.apiEndpoint || 'https://openrouter.ai/api/v1/chat/completions') || currentConfig.apiEndpoint;
      const key = prompt('API Key:') || currentConfig.apiKey;
      const model = prompt('Model:', currentConfig.model || 'qwen/qwen3-coder:free') || currentConfig.model;
      const newConfig = { ...currentConfig, apiEndpoint: ep, apiKey: key, model };
      localStorage.setItem('hypoAssistantConfig', JSON.stringify(newConfig));
      addMsg('✅ Config saved.', 'assist');
      // Триггер сброса индекса при смене ключа
      if (key && key !== currentConfig.apiKey) {
        localStorage.removeItem('hypoAssistantSemanticIndex');
        addMsg('🔄 Semantic index will be rebuilt on next request.', 'assist');
      }
    };
  }
}
