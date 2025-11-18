import { StorageAdapter } from '../../config/StorageAdapter.js';
import { ChatPanel } from './ChatPanel.js';
import {Terminable} from "../../types";

export class ConfigView {
    constructor(
        private storage: StorageAdapter,
        private chatPanel: ChatPanel
    ) {}

    show(): Terminable {
        const templateEl = document.getElementById('hypo-config-widget-template');
        if (!(templateEl instanceof HTMLTemplateElement)) {
            throw new Error('Config widget template not found');
        }

        const frag = document.importNode(templateEl.content, true);
        const widget = frag.firstElementChild as HTMLElement;
        if (!widget) throw new Error('Config widget root element missing');

        const endpointInput = widget.querySelector('[name="apiEndpoint"]') as HTMLInputElement;
        const keyInput = widget.querySelector('[name="apiKey"]') as HTMLInputElement;
        const modelInput = widget.querySelector('[name="model"]') as HTMLInputElement;
        const saveBtn = widget.querySelector('.hypo-config-save-btn') as HTMLElement;

        if (!endpointInput || !keyInput || !modelInput || !saveBtn) {
            throw new Error('Config widget form elements missing');
        }

        // Загрузка конфига
        const configRaw = localStorage.getItem('hypoAssistantConfig');
        let config = configRaw ? JSON.parse(configRaw) : {};
        if (config.apiKey !== undefined || config.apiEndpoint !== undefined || config.model !== undefined) {
            config = { llm: { apiKey: config.apiKey, apiEndpoint: config.apiEndpoint, model: config.model } };
        }
        const llm = config.llm || {};

        endpointInput.value = llm.apiEndpoint || 'https://openrouter.ai/api/v1/chat/completions';
        keyInput.value = llm.apiKey || '';
        modelInput.value = llm.model || 'tngtech/deepseek-r1t2-chimera:free';

        // Freeze-функция для внешнего управления
        const freeze = () => {
            widget.querySelectorAll('.ha-input').forEach(el => {
                (el as HTMLInputElement).disabled = true;
            });
            saveBtn.remove();
            widget.classList.add('frozen');
        };

        // Обработчик сохранения
        saveBtn.addEventListener('click', () => {
            const newConfig = {
                llm: {
                    apiEndpoint: endpointInput.value.trim(),
                    apiKey: keyInput.value.trim(),
                    model: modelInput.value.trim()
                }
            };

            localStorage.setItem('hypoAssistantConfig', JSON.stringify(newConfig));
            this.chatPanel.addMessage('✅ LLM config saved.', 'assist');

            if (keyInput.value && keyInput.value !== llm.apiKey) {
                localStorage.removeItem('hypoAssistantSemanticIndex');
                this.chatPanel.addMessage('🔄 Semantic index will be rebuilt on next request.', 'assist');
            }

            freeze(); // после сохранения — фризим
        });

        this.chatPanel.addMessageWidget(widget, 'assist');

        return { freeze };
    }
}