// src/ui/components/PatchListView.ts

import type { StoredPatch } from '../../types.js';
import { PatchManager } from '../../core/PatchManager.js';
import { StorageAdapter } from '../../config/StorageAdapter.js';
import { ChatPanel } from './ChatPanel.js';

export class PatchListView {
    constructor(
        private chatPanel: ChatPanel,
        private patchItemTemplate: HTMLTemplateElement,
        private patchWidgetTemplate: HTMLTemplateElement, // ← новый шаблон
        private storage: StorageAdapter,
        private onFrozen?: () => void
    ) {}

    show(): void {
        const frag = document.importNode(this.patchWidgetTemplate.content, true);
        const widget = frag.firstElementChild as HTMLElement;
        const listContainer = widget.querySelector('.hypo-patch-list')!;
        const emptyEl = widget.querySelector('.hypo-patch-empty')!;
        const saveBtn = widget.querySelector('.hypo-patch-save-btn')!;

        const patches = this.storage.getPatches();

        if (patches.length === 0) {
            emptyEl.style.display = 'block';
            saveBtn.style.display = 'none'; // нет смысла сохранять пустоту
        } else {
            emptyEl.style.display = 'none';
            saveBtn.style.display = 'block';

            patches.forEach(p => {
                const itemFrag = document.importNode(this.patchItemTemplate.content, true);
                const checkbox = itemFrag.querySelector('input')!;
                const titleSpan = itemFrag.querySelector('span')!;
                const dateEl = itemFrag.querySelector('small')!;

                checkbox.dataset.id = p.id;
                checkbox.checked = p.enabled;
                titleSpan.textContent = p.title;
                titleSpan.title = p.id;
                dateEl.textContent = new Date(p.createdAt).toLocaleDateString();

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

                listContainer.appendChild(itemFrag);
            });

            // Обработчик "Save & Freeze"
            saveBtn.onclick = () => {
                // Блокируем все чекбоксы
                widget.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    (cb as HTMLInputElement).disabled = true;
                });
                saveBtn.remove(); // убираем кнопку

                this.onFrozen?.();
            };
        }

        // Добавляем виджет как сообщение от ассистента
        this.chatPanel.addMessageWidget(widget, 'assist');
    }
}