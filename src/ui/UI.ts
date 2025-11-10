// ТЕЗИС: UI создаёт свой DOM самостоятельно — библиотека полностью self-contained.
// ТЕЗИС: Вся разметка содержится в getTemplate(), включая <template>.
// ТЕЗИС: JS управляет DOM — не генерирует разметку.
// ТЕЗИС: Конфигурация всегда имеет древовидную структуру: { llm: { apiKey, ... } }

import type { PatchResult, StoredPatch } from '../types';
import { PatchManager } from '../core/PatchManager.js';
import { StorageAdapter } from '../config/StorageAdapter.js';

export class HypoAssistantUI {
    private panel: HTMLElement | null = null;
    private abortController: AbortController | null = null;
    private patchItemTemplate: HTMLTemplateElement | null = null;

    constructor(
        private onUserRequest: (query: string, signal: AbortSignal) => Promise<PatchResult>,
        private storage: StorageAdapter
    ) {}

    private getTemplate(): string {
        return `
<!-- Floating toggle button -->
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

<!-- Main panel -->
<div id="hypo-panel" style="
  display: none;
  position: fixed;
  right: 0;
  top: 0;
  width: 100vw;
  height: 100dvh;
  min-height: 100dvh;
  max-width: 360px;
  background: #1e1e1e;
  color: #e0e0e0;
  font-family: monospace;
  z-index: 10000;
  box-shadow: -2px 0 10px rgba(0,0,0,0.5);
  flex-direction: column;
">
  <div style="padding: 10px; background: #2d2d2d; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
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
  <div id="hypo-chat" style="
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    font-size: 13px;
    min-height: 0;
  "></div>
  <div style="display: flex; padding: 10px; background: #252526; flex-shrink: 0;">
    <input type="text" placeholder="Describe change..." id="hypo-input-field" style="flex: 1; background: #333; color: white; border: none; padding: 8px; border-radius: 3px;">
    <button id="hypo-send" style="background: #007acc; color: white; border: none; padding: 8px 12px; margin-left: 8px; border-radius: 3px; cursor: pointer;">Send</button>
  </div>
  <div style="padding: 10px; display: flex; gap: 6px; flex-shrink: 0;">
    <button id="hypo-export" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">📤 Export</button>
    <button id="hypo-patch-manager" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">🧩 Patches</button>
    <button id="hypo-settings" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">⚙️ Settings</button>
    <button id="hypo-reload" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">🔄 Reload</button>
  </div>
</div>

<!-- Hidden template for patch items -->
<template id="hypo-patch-item-template">
  <div style="margin:8px 0; padding:8px; background:#3a3a3a; border-radius:4px;">
    <label style="display:flex; align-items:center; gap:8px;">
      <input type="checkbox">
      <span style="color:white;"></span>
    </label>
    <small style="color:#888; font-size:11px;"></small>
  </div>
</template>
        `;
    }

    public show(): void {
        if (this.panel) return;

        this.panel = document.createElement('div');
        this.panel.id = 'hypo-assistant-core';
        this.panel.innerHTML = this.getTemplate();
        document.body.appendChild(this.panel);

        this.patchItemTemplate = document.getElementById('hypo-patch-item-template') as HTMLTemplateElement;

        const toggleBtn = document.getElementById('hypo-toggle')!;
        const mainPanel = document.getElementById('hypo-panel')!;
        const collapseBtn = document.getElementById('hypo-collapse')!;
        const chat = document.getElementById('hypo-chat')!;
        const input = document.getElementById('hypo-input-field') as HTMLInputElement;
        const sendBtn = document.getElementById('hypo-send')!;
        const exportBtn = document.getElementById('hypo-export')!;
        const patchManagerBtn = document.getElementById('hypo-patch-manager')!;
        const settingsBtn = document.getElementById('hypo-settings')!;
        const reloadBtn = document.getElementById('hypo-reload')!;

        const addMessage = (text: string, role: 'user' | 'assist'): void => {
            const msg = document.createElement('div');
            msg.className = `msg ${role}`;
            msg.textContent = text;
            chat.appendChild(msg);
            chat.scrollTop = chat.scrollHeight;
        };

        const showPatchList = (): void => {
            const patches = this.storage.getPatches();
            chat.innerHTML = '';

            if (patches.length === 0) {
                const empty = document.createElement('p');
                empty.style.color = '#888';
                empty.textContent = 'No patches yet.';
                chat.appendChild(empty);
            } else {
                patches.forEach(p => {
                    const frag = document.importNode(this.patchItemTemplate!.content, true);
                    const checkbox = frag.querySelector('input')!;
                    const titleSpan = frag.querySelector('span')!;
                    const dateEl = frag.querySelector('small')!;

                    checkbox.dataset.id = p.id;
                    checkbox.checked = p.enabled;
                    titleSpan.textContent = p.title;
                    titleSpan.title = p.id;
                    dateEl.textContent = new Date(p.createdAt).toLocaleString();

                    checkbox.addEventListener('change', () => {
                        const id = checkbox.dataset.id;
                        if (!id) return;
                        const current = this.storage.getPatches();
                        const updated = current.map(pp => pp.id === id ? { ...pp, enabled: checkbox.checked } : pp);
                        this.storage.savePatches(updated);
                        if (checkbox.checked) {
                            const patch = updated.find(pp => pp.id === id)!;
                            PatchManager.applyToolCalls([patch.toolCall]);
                        }
                    });

                    chat.appendChild(frag);
                });
            }

            const backBtn = document.createElement('button');
            backBtn.textContent = '← Back to chat';
            backBtn.style.cssText = `
                margin-top: 12px;
                padding: 6px 12px;
                background: #555;
                color: white;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
            `;
            backBtn.onclick = () => {
                chat.innerHTML = '';
                addMessage('🦛 Ready. Describe your change.', 'assist');
            };
            chat.appendChild(backBtn);
        };

        toggleBtn.onclick = () => {
            toggleBtn.style.display = 'none';
            mainPanel.style.display = 'flex';
        };

        collapseBtn.onclick = () => {
            mainPanel.style.display = 'none';
            toggleBtn.style.display = 'flex';
        };

        patchManagerBtn.onclick = () => showPatchList();

        sendBtn.onclick = async () => {
            const query = input.value.trim();
            if (!query) return;
            input.value = '';
            addMessage(query, 'user');

            this.abortController?.abort();
            this.abortController = new AbortController();

            // === Используем древовидный конфиг ===
            const configRaw = localStorage.getItem('hypoAssistantConfig');
            const config = configRaw ? JSON.parse(configRaw) : {};

            // Поддержка старого плоского конфига → миграция
            const llmConfig = config.llm || {
                apiKey: config.apiKey,
                apiEndpoint: config.apiEndpoint,
                model: config.model
            };

            if (!llmConfig.apiKey) {
                addMessage('⚠️ Set API key in ⚙️', 'assist');
                return;
            }

            try {
                const result = await this.onUserRequest(query, this.abortController.signal);
                addMessage(result.groupTitle, 'assist');

                if (confirm('Apply patch?')) {
                    const existing = this.storage.getPatches();
                    const updated = [...existing, ...result.patches];
                    PatchManager.applyToolCalls(result.patches.map(p => p.toolCall));
                    this.storage.savePatches(updated);
                    addMessage('✅ Applied. Enable in "🧩 Patches" to persist.', 'assist');
                }
            } catch (err) {
                if ((err as Error).name !== 'AbortError') {
                    addMessage(`❌ ${(err as Error).message}`, 'assist');
                }
            }
        };

        exportBtn.onclick = () => {
            const clonedDoc = document.cloneNode(true) as Document;
            const script = clonedDoc.querySelector('script[src="./HypoAssistant.js"]');
            if (script) script.remove();
            clonedDoc.querySelectorAll('script:not([src]):not([id])').forEach(el => {
                if (el.textContent?.includes('hashLang')) el.remove();
            });
            const core = clonedDoc.getElementById('hypo-assistant-core');
            if (core) core.remove();

            const blob = new Blob([`<!DOCTYPE html>\n${clonedDoc.documentElement.outerHTML}`], { type: 'text/html' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'patched-page.html';
            a.click();
            URL.revokeObjectURL(url);
        };

        settingsBtn.onclick = () => {
            const configRaw = localStorage.getItem('hypoAssistantConfig');
            let config = configRaw ? JSON.parse(configRaw) : {};

            // 🔁 Миграция: если конфиг плоский — переносим в llm
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
            addMessage('✅ Config saved.', 'assist');

            if (key && key !== llm.apiKey) {
                localStorage.removeItem('hypoAssistantSemanticIndex');
                addMessage('🔄 Semantic index will be rebuilt on next request.', 'assist');
            }
        };

        reloadBtn.onclick = () => location.reload();

        addMessage('🦛 Ready. Describe your change.', 'assist');
    }
}