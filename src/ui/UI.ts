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
<style>
  #hypo-assistant-core {
    /* --- Кастомизация через CSS vars --- */
    --ha-space-xs: 4px;
    --ha-space-s: 8px;
    --ha-space-m: 12px;
    --ha-space-l: 16px;
    --ha-space-xl: 20px;

    --ha-radius-s: 8px;
    --ha-radius-m: 12px;
    --ha-radius-l: 16px;
    --ha-radius-full: 50%;

    --ha-btn-size: 40px;
    --ha-panel-width: 360px;

    /* Цвета — светлая тема по умолчанию */
    --ha-bg: #ffffff;
    --ha-surface: #ffffff;
    --ha-text: #111111;
    --ha-text-secondary: #666666;
    --ha-border: #e0e0e0;
    --ha-brand: #6c63ff;
    --ha-user-bg: #e6e6ff;
    --ha-coach-bg: #f0f0f0;
    --ha-shadow: 0 6px 16px rgba(0,0,0,0.08);
    --ha-shadow-toggle: 0 4px 12px rgba(0,0,0,0.12);
  }

  @media (prefers-color-scheme: dark) {
    #hypo-assistant-core {
      --ha-bg: #121212;
      --ha-surface: #1e1e1e;
      --ha-text: #e0e0e0;
      --ha-text-secondary: #a0a0a0;
      --ha-border: #333333;
      --ha-user-bg: #2a273f;
      --ha-coach-bg: #2d2d2d;
    }
  }

  #hypo-assistant-core *,
  #hypo-assistant-core *::before,
  #hypo-assistant-core *::after {
    box-sizing: border-box;
  }
</style>

<!-- Toggle button -->
<button id="hypo-toggle" aria-label="Open HypoAssistant" style="
  position: fixed;
  bottom: var(--ha-space-l);
  right: var(--ha-space-l);
  width: var(--ha-btn-size);
  height: var(--ha-btn-size);
  background: var(--ha-brand);
  color: white;
  border-radius: var(--ha-radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 10000;
  box-shadow: var(--ha-shadow-toggle);
  border: none;
  padding: 0;
  font: inherit;
">🦛</button>

<!-- Main panel -->
<div id="hypo-panel" style="
  display: none;
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  max-width: var(--ha-panel-width);
  background: var(--ha-bg);
  color: var(--ha-text);
  font-family: 'Inter', system-ui, sans-serif;
  z-index: 10000;
  flex-direction: column;
  box-shadow: -2px 0 12px rgba(0,0,0,0.08);
  overflow: hidden;
">
  <div style="padding: var(--ha-space-m); background: var(--ha-surface); display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--ha-border);">
    <div style="font-weight: 600; font-size: 16px; display: flex; align-items: center; gap: var(--ha-space-xs);">
      🦛 <span>HypoAssistant v1.1</span>
    </div>
    <button id="hypo-collapse" aria-label="Collapse panel" style="
      background: none;
      color: var(--ha-text-secondary);
      border: none;
      width: 24px;
      height: 24px;
      border-radius: var(--ha-radius-full);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font: inherit;
    ">
      <!-- collapse icon (chevron left) -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    </button>
  </div>

  <div id="hypo-chat" style="
    flex: 1;
    overflow-y: auto;
    padding: var(--ha-space-l);
    font-size: 14px;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-m);
  "></div>

  <div style="padding: var(--ha-space-m) var(--ha-space-l) var(--ha-space-l); background: var(--ha-surface);">
    <div style="display: flex; gap: var(--ha-space-s);">
      <input type="text" placeholder="Describe change..." id="hypo-input-field" style="
        flex: 1;
        background: var(--ha-surface);
        color: var(--ha-text);
        border: 1px solid var(--ha-border);
        border-radius: var(--ha-radius-m);
        padding: var(--ha-space-s) var(--ha-space-m);
        font-family: inherit;
        font-size: 14px;
      ">
      <button id="hypo-send" aria-label="Send" style="
        width: var(--ha-btn-size);
        height: var(--ha-btn-size);
        background: var(--ha-brand);
        color: white;
        border: none;
        border-radius: var(--ha-radius-full);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
      ">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  </div>

  <div style="padding: 0 var(--ha-space-l) var(--ha-space-l); display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--ha-space-s);">
    <button id="hypo-export" style="
      padding: var(--ha-space-s);
      background: var(--ha-surface);
      border: 1px solid var(--ha-border);
      border-radius: var(--ha-radius-m);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--ha-space-xs);
      font-size: 12px;
      color: var(--ha-text);
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Export
    </button>
    <button id="hypo-patch-manager" style="
      padding: var(--ha-space-s);
      background: var(--ha-surface);
      border: 1px solid var(--ha-border);
      border-radius: var(--ha-radius-m);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--ha-space-xs);
      font-size: 12px;
      color: var(--ha-text);
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"></line>
        <line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line>
        <line x1="3" y1="6" x2="3" y2="6"></line>
        <line x1="3" y1="12" x2="3" y2="12"></line>
        <line x1="3" y1="18" x2="3" y2="18"></line>
      </svg>
      Patches
    </button>
    <button id="hypo-settings" style="
      padding: var(--ha-space-s);
      background: var(--ha-surface);
      border: 1px solid var(--ha-border);
      border-radius: var(--ha-radius-m);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--ha-space-xs);
      font-size: 12px;
      color: var(--ha-text);
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1.51-1.65 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1.65 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      Settings
    </button>
    <button id="hypo-reload" style="
      padding: var(--ha-space-s);
      background: var(--ha-surface);
      border: 1px solid var(--ha-border);
      border-radius: var(--ha-radius-m);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--ha-space-xs);
      font-size: 12px;
      color: var(--ha-text);
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
      Reload
    </button>
  </div>
</div>

<!-- Template for patch items -->
<template id="hypo-patch-item-template">
  <div style="padding: var(--ha-space-m); background: var(--ha-surface); border-radius: var(--ha-radius-m); border: 1px solid var(--ha-border);">
    <label style="display: flex; align-items: center; gap: var(--ha-space-s);">
      <input type="checkbox" style="width: 16px; height: 16px;">
      <span style="color: var(--ha-text); font-weight: 500;"></span>
    </label>
    <small style="color: var(--ha-text-secondary); font-size: 11px; margin-top: var(--ha-space-xs); display: block;"></small>
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