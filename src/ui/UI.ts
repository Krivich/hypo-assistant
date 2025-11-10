// ТЕЗИС: UI создаёт свой DOM самостоятельно — библиотека полностью self-contained.
// ТЕЗИС: UI не содержит бизнес-логики — только отображение и маршрутизация событий.

import type { PatchResult, StoredPatch } from '../types';
import { PatchManager } from '../core/PatchManager.js';
import { StorageAdapter } from '../config/StorageAdapter.js';

export class HypoAssistantUI {
    private panel: HTMLElement | null = null;
    private abortController: AbortController | null = null;

    constructor(
        private onUserRequest: (query: string, signal: AbortSignal) => Promise<PatchResult>,
        private storage: StorageAdapter
    ) {}

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
        <button id="hypo-export" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">📤 Export</button>
        <button id="hypo-patch-manager" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">🧩 Patches</button>
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
        const chat = document.getElementById('hypo-chat')!;
        const input = document.getElementById('hypo-input-field') as HTMLInputElement;
        const send = document.getElementById('hypo-send')!;
        const exportBtn = document.getElementById('hypo-export')!;
        const patchManagerBtn = document.getElementById('hypo-patch-manager')!;
        const settings = document.getElementById('hypo-settings')!;
        const reload = document.getElementById('hypo-reload')!;

        // Toggle panel
        toggleBtn.onclick = () => {
            toggleBtn.style.display = 'none';
            panel.style.display = 'flex';
        };

        collapseBtn.onclick = () => {
            panel.style.display = 'none';
            toggleBtn.style.display = 'flex';
        };

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
                addMsg(res.message, 'assist'); // ← используем groupTitle как сообщение

                if (confirm('Apply patch?')) {
                    const existingPatches = this.storage.getPatches();
                    const allPatches = [...existingPatches, ...res.patches];

                    // Применяем ВСЮ группу
                    const toolCalls = res.patches.map(p => p.toolCall);
                    PatchManager.applyToolCalls(toolCalls);

                    this.storage.savePatches(allPatches);
                    addMsg('✅ Applied. Enable in "🧩 Patches" to persist.', 'assist');
                }
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    addMsg(`❌ ${(err as Error).message}`, 'assist');
                }
            }
        };

        exportBtn.onclick = () => {
            const tempDoc = document.cloneNode(true) as Document;
            const hypoScript = tempDoc.querySelector('script[src="./HypoAssistant.js"]');
            if (hypoScript) hypoScript.remove();
            tempDoc.querySelectorAll('script:not([src]):not([id])').forEach(script => {
                if (script.textContent?.includes('hashLang')) script.remove();
            });
            const coreEl = tempDoc.getElementById('hypo-assistant-core');
            if (coreEl) coreEl.remove();
            const html = `<!DOCTYPE html>\n${tempDoc.documentElement.outerHTML}`;
            const blob = new Blob([html], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'patched-page.html';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };

        patchManagerBtn.onclick = () => {
            const patches = this.storage.getPatches();
            const panelEl = document.createElement('div');
            panelEl.innerHTML = `
        <div style="background:#2d2d2d; padding:10px; max-height:60vh; overflow:auto;">
          <h3 style="margin:0 0 10px; color:white;">Applied Patches</h3>
          ${patches.length === 0 ? '<p style="color:#888;">No patches yet.</p>' : patches.map(p => `
            <div style="margin:8px 0; padding:8px; background:#3a3a3a; border-radius:4px;">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" data-id="${p.id}" ${p.enabled ? 'checked' : ''}>
                <span title="${p.id}" style="color:white;">${p.title}</span>
              </label>
              <small style="color:#888; font-size:11px;">${new Date(p.createdAt).toLocaleString()}</small>
            </div>
          `).join('')}
          <button id="hypo-close-patches" style="margin-top:10px; background:#555; color:white; border:none; padding:6px 12px; border-radius:3px;">Close</button>
        </div>
      `;
            chat.appendChild(panelEl);

            panelEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                cb.addEventListener('change', () => {
                    const id = cb.dataset.id; // ← вот так правильно
                    if (!id) return; // защита от ошибки

                    const currentPatches = this.storage.getPatches();
                    const updated = currentPatches.map(p =>
                        p.id === id ? { ...p, enabled: cb.checked } : p
                    );
                    this.storage.savePatches(updated);
                    if (cb.checked) {
                        const patch = updated.find(p => p.id === id)!;
                        PatchManager.applyToolCalls([patch.toolCall]);
                    }
                });
            });

            panelEl.querySelector('#hypo-close-patches')!.addEventListener('click', () => {
                panelEl.remove();
            });
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
            if (key && key !== currentConfig.apiKey) {
                localStorage.removeItem('hypoAssistantSemanticIndex');
                addMsg('🔄 Semantic index will be rebuilt on next request.', 'assist');
            }
        };
    }
}