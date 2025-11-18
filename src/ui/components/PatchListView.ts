// src/ui/components/PatchListView.ts
import { PatchManager } from '../../core/PatchManager.js';
import { StorageAdapter } from '../../config/StorageAdapter.js';
import { ChatPanel } from './ChatPanel.js';
import { Terminable, TerminateReason, PatchGroup } from '../../types.js';

export class PatchListView {
    private readonly groupHeaderTemplate: HTMLTemplateElement;
    private readonly groupTemplate: HTMLTemplateElement;
    private tempPatchStates = new Map<string, boolean>();
    private readonly appliedOnce = new Set<string>();

    constructor(
        private chatPanel: ChatPanel,
        private patchItemTemplate: HTMLTemplateElement,
        private patchWidgetTemplate: HTMLTemplateElement,
        private storage: StorageAdapter,
        private onTerminate?: (reason: TerminateReason) => void
    ) {
        this.groupHeaderTemplate = document.getElementById('hypo-patch-group-header-template') as HTMLTemplateElement;
        this.groupTemplate = document.getElementById('hypo-patch-group-template') as HTMLTemplateElement;
    }

    show(): Terminable {
        const groups = this.storage.getPatchGroups();

        this.tempPatchStates.clear();
        groups.forEach(g => {
            g.patches.forEach(p => {
                this.tempPatchStates.set(p.id, p.enabled);
                if (p.enabled) {
                    this.appliedOnce.add(p.id);
                }
            });
        });

        const widget = document.importNode(this.patchWidgetTemplate.content, true).firstElementChild as HTMLElement;
        if (!widget) throw new Error('Patch widget template is invalid');

        const listContainer = widget.querySelector<HTMLElement>('.hypo-patch-list')!;
        const emptyEl = widget.querySelector<HTMLElement>('.hypo-patch-empty')!;
        const saveBtn = widget.querySelector<HTMLButtonElement>('.hypo-patch-save-btn')!;

        const hasPatches = groups.some(g => g.patches.length > 0);
        emptyEl.style.display = hasPatches ? 'none' : 'block';
        saveBtn.style.display = hasPatches ? 'block' : 'none';

        if (hasPatches) {
            groups.forEach(group => {
                const groupEl = document.importNode(this.groupTemplate.content, true).firstElementChild as HTMLElement;
                const itemsContainer = groupEl.querySelector<HTMLElement>('.patch-items')!;
                const headerEl = document.importNode(this.groupHeaderTemplate.content, true).firstElementChild as HTMLElement;

                const triStateIcon = headerEl.querySelector<HTMLElement>('.tri-state-icon')!;
                const groupTitleEl = headerEl.querySelector<HTMLElement>('.group-title')!;
                const toggleBtn = headerEl.querySelector<HTMLButtonElement>('.toggle-group-btn')!;

                groupTitleEl.textContent = group.groupTitle;

                const updateIcon = () => {
                    const enabled = group.patches.filter(p => this.tempPatchStates.get(p.id) ?? false).length;
                    const total = group.patches.length;
                    triStateIcon.className = 'tri-state-icon' +
                        (enabled === 0 ? '' : enabled === total ? ' checked' : ' partial');
                };
                updateIcon();

                headerEl.addEventListener('click', (e) => {
                    if ((e.target as HTMLElement).closest('.toggle-group-btn')) return;
                    e.preventDefault();

                    const enabled = group.patches.filter(p => this.tempPatchStates.get(p.id) ?? false).length;
                    const total = group.patches.length;
                    const target = enabled === total ? false : true;

                    group.patches.forEach(p => {
                        const wasEnabled = this.tempPatchStates.get(p.id) ?? false;
                        if (wasEnabled !== target) {
                            this.tempPatchStates.set(p.id, target);
                            if (target && !this.appliedOnce.has(p.id)) {
                                PatchManager.applyToolCalls([p.toolCall]);
                                this.appliedOnce.add(p.id);
                            }
                        }
                    });

                    itemsContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => {
                        const id = cb.dataset.id;
                        if (id) cb.checked = target;
                    });

                    updateIcon();
                });

                toggleBtn.addEventListener('click', () => {
                    groupEl.classList.toggle('expanded');
                    itemsContainer.style.display = groupEl.classList.contains('expanded') ? 'block' : 'none';
                });

                groupEl.insertBefore(headerEl, itemsContainer);

                group.patches.forEach(p => {
                    const item = document.importNode(this.patchItemTemplate.content, true).firstElementChild as HTMLElement;
                    const checkbox = item.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
                    const titleSpan = item.querySelector<HTMLSpanElement>('span')!;
                    const dateEl = item.querySelector<HTMLSpanElement>('small')!;

                    checkbox.dataset.id = p.id;
                    const current = this.tempPatchStates.get(p.id) ?? p.enabled;
                    checkbox.checked = current;

                    titleSpan.textContent = p.title;
                    dateEl.textContent = new Date(p.createdAt).toLocaleDateString();

                    checkbox.addEventListener('change', () => {
                        const id = checkbox.dataset.id;
                        if (!id) return;

                        const enabled = checkbox.checked;
                        const wasEnabled = this.tempPatchStates.get(id) ?? false;

                        if (enabled !== wasEnabled) {
                            this.tempPatchStates.set(id, enabled);
                            if (enabled && !wasEnabled && !this.appliedOnce.has(id)) {
                                const patch = group.patches.find(pp => pp.id === id);
                                if (patch) {
                                    PatchManager.applyToolCalls([patch.toolCall]);
                                    this.appliedOnce.add(id);
                                }
                            }
                        }

                        updateIcon();
                    });

                    itemsContainer.appendChild(item);
                });

                listContainer.appendChild(groupEl);
            });
        }

        // === Безопасное сохранение с мержем ===
        const save = () => {
            const currentGroups = this.storage.getPatchGroups();
            const knownPatchIds = new Set<string>();
            groups.forEach(g => g.patches.forEach(p => knownPatchIds.add(p.id)));

            const mergedGroups = currentGroups.map(g => ({
                ...g,
                patches: g.patches.map(p =>
                    knownPatchIds.has(p.id)
                        ? { ...p, enabled: this.tempPatchStates.get(p.id) ?? p.enabled }
                        : p
                )
            }));

            this.storage.savePatchGroups(mergedGroups);
        };

        // === Только UI-заморозка ===
        const freeze = () => {
            widget.querySelectorAll('input[type="checkbox"]').forEach(el => (el as HTMLInputElement).disabled = true);
            widget.querySelectorAll('.toggle-group-btn').forEach(el => (el as HTMLElement).style.pointerEvents = 'none');
            saveBtn.remove();
            widget.classList.add('frozen');
        };

        // === Кнопка: сохранить → заморозить → уведомить ===
        saveBtn.addEventListener('click', () => {
            save();
            freeze();
            this.onTerminate?.('save');
        });

        this.chatPanel.addMessageWidget(widget, 'assist');

        return {
            freeze: () => {
                // Внешний freeze — только UI, без колбэка
                freeze();
                // Не вызываем onTerminate('freeze') — сообщение не нужно
            }
        };
    }
}