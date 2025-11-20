import {PatchGroup, PatchResult, StoredPatch, Terminable} from '../types.js';
import { PatchManager } from '../core/PatchManager.js';
import { StorageAdapter } from '../config/StorageAdapter.js';
import { AdaptiveProgressObserver } from '../utils/AdaptiveProgressObserver.js';
import { ToggleButton } from './components/ToggleButton.js';
import { ChatPanel } from './components/ChatPanel.js';
import {ProgressView} from './components/ProgressTree.js';
import { PatchListView } from './components/PatchListView.js';
import { ExportHandler } from './components/ExportHandler.js';
// Импорт разметки как строки (требует esbuild loader для .html)
import TEMPLATE_HTML from './index.html';
import STYLES_CSS from './styles.css';
import {ConfigView} from "./components/ConfigView";

export class HypoAssistantUI {
    private panel: HTMLElement | null = null;
    private abortController: AbortController | null = null;
    private toggleButton!: ToggleButton;
    private chatPanel!: ChatPanel;
    private progressView: ProgressView | null = null;
    private activeConfigWidget: Terminable  | null = null;
    private activePatchWidget: Terminable | null = null;
    private tempActivePatches: StoredPatch[] = []; // ← добавлено

    constructor(
        private onUserRequest: (
            query: string,
            progress: AdaptiveProgressObserver,
            signal: AbortSignal,
            tempActivePatches?: StoredPatch[]
        ) => Promise<PatchResult>,
        private storage: StorageAdapter
    ) {}

    public show(): void {
        if (this.panel) return;
        this.injectStyles();
        this.injectMarkup();
        const elements = this.getUIElements();
        this.panel = elements.panelEl;
        this.initializeComponents(elements);
        this.bindGlobalActions(elements);
        this.setupChatAndPatches(elements);
        this.setupInputHandling(elements);
        this.showInitialMessage();
    }

// === Вспомогательные методы ===
    private injectStyles(): void {
        if (!document.getElementById('hypo-assistant-styles')) {
            const style = document.createElement('style');
            style.id = 'hypo-assistant-styles';
            style.textContent = STYLES_CSS;
            document.head.appendChild(style);
        }
    }

    private injectMarkup(): void {
        const frag = document.createRange().createContextualFragment(TEMPLATE_HTML);
        document.body.appendChild(frag);
    }

    private getUIElements() {
        const panelEl = document.getElementById('hypo-panel')!;
        const toggleEl = document.getElementById('hypo-toggle')! as HTMLButtonElement;
        const chatEl = document.getElementById('hypo-chat')!;
        const patchItemTpl = document.getElementById('hypo-patch-item-template') as HTMLTemplateElement;
        const progressLineTpl = document.getElementById('hypo-progress-line-template') as HTMLTemplateElement;
        const progressHeaderTpl = document.getElementById('hypo-progress-header-template') as HTMLTemplateElement;
        const cancelIconTpl = document.getElementById('hypo-cancel-icon-template') as HTMLTemplateElement;
        const sendBtn = document.getElementById('hypo-send')!;
        const inputField = document.getElementById('hypo-input-field') as HTMLInputElement;
        return {
            panelEl,
            toggleEl,
            chatEl,
            patchItemTpl,
            progressLineTpl,
            progressHeaderTpl,
            cancelIconTpl,
            sendBtn,
            inputField
        };
    }

    private initializeComponents(elements: ReturnType<HypoAssistantUI['getUIElements']>) {
        this.toggleButton = new ToggleButton(elements.toggleEl);
        this.chatPanel = new ChatPanel(elements.chatEl);
    }

    private bindGlobalActions(elements: ReturnType<HypoAssistantUI['getUIElements']>) {
        const { panelEl } = elements;
        this.toggleButton.onClick(() => {
            this.toggleButton.hide();
            panelEl.style.display = 'flex';
        });
        document.getElementById('hypo-collapse')!.onclick = () => {
            panelEl.style.display = 'none';
            this.toggleButton.show();
        };
        document.getElementById('hypo-reload')!.onclick = () => location.reload();
    }

    private setupChatAndPatches(elements: ReturnType<HypoAssistantUI['getUIElements']>) {
        const { chatEl, patchItemTpl } = elements;
        const showMainChat = () => {
            this.chatPanel.clear();
            this.chatPanel.addMessage('🦛 Ready. Describe your change.', 'assist');
        };

        // В setupChatAndPatches():
        const patchList = new PatchListView(
            this.chatPanel,
            patchItemTpl,
            document.getElementById('hypo-patch-widget-template') as HTMLTemplateElement,
            this.storage,
            (reason) => {
                if (reason === 'save') {
                    this.chatPanel.addMessage(
                        '✅ Patch settings saved. Changes will persist after reload.',
                        'assist'
                    );
                }
            }
        );
        document.getElementById('hypo-patch-manager')!.onclick = () => {
            this.activePatchWidget?.freeze();
            this.activePatchWidget = patchList.show();
        };

        const configView = new ConfigView(this.storage, this.chatPanel);
        document.getElementById('hypo-settings')!.onclick = () => {
            this.activeConfigWidget?.freeze();
            this.activeConfigWidget = configView.show();
        };

        const exportHandler = new ExportHandler();
        document.getElementById('hypo-export')!.onclick = () => {
            exportHandler.export();
        };
    }

    private setupInputHandling(elements: ReturnType<HypoAssistantUI['getUIElements']>) {
        const { sendBtn, inputField, progressLineTpl, progressHeaderTpl, cancelIconTpl } = elements;
        const originalSendIcon = sendBtn.innerHTML;
        const setSendButtonState = (isWorking: boolean) => {
            if (isWorking) {
                sendBtn.innerHTML = '';
                sendBtn.appendChild(document.importNode(cancelIconTpl.content, true));
                sendBtn.setAttribute('aria-label', 'Cancel');
            } else {
                sendBtn.innerHTML = originalSendIcon;
                sendBtn.setAttribute('aria-label', 'Send');
            }
        };

        const handleSend = async () => {
            const query = inputField.value.trim();
            if (!query) return;
            inputField.value = '';
            this.chatPanel.addMessage(query, 'user');

            // 🔑 КЛЮЧ: сбрасываем ссылку на текущий прогресс-виджет
            this.progressView?.freeze(); // зафиксировать предыдущий, если был
            this.progressView = null;
            this.abortController?.abort();
            this.abortController = new AbortController();

            setSendButtonState(true);
            const progress = new AdaptiveProgressObserver((update) => {
                if (!this.progressView) {
                    this.progressView = new ProgressView(this.chatPanel, progressLineTpl, query);
                }
                this.progressView.render(update.path, update.remainingMs);
                // Прокручиваем к виджету (не к .container, а к .widget)
                this.progressView.widget.scrollIntoView({ behavior: 'smooth' });
            });

            try {
                const result = await this.onUserRequest(
                    query,
                    progress,
                    this.abortController.signal,
                    this.tempActivePatches
                );
                this.progressView?.freeze();
                setSendButtonState(false);
                this.chatPanel.addMessage(result.groupTitle, 'assist');

                if (confirm('Apply patch?')) {
                    const requestId = crypto.randomUUID();
                    const newGroup: PatchGroup = {
                        requestId,
                        userQuery: query,
                        groupTitle: result.groupTitle,
                        patches: result.patches.map(p => ({
                            ...p,
                            requestId
                        }))
                    };

                    // ✅ Добавляем к временным патчам (для контекста LLM)
                    this.tempActivePatches = [...this.tempActivePatches, ...newGroup.patches];

                    // Применяем визуально — но НЕ сохраняем в storage
                    PatchManager.applyToolCalls(newGroup.patches.map(p => p.toolCall));

                    this.chatPanel.addMessage('✅ Applied. Enable in "🧩 Patches" to persist.', 'assist');
                }
            } catch (err) {
                this.progressView?.freeze();
                setSendButtonState(false);
                if ((err as Error).name !== 'AbortError') {
                    this.chatPanel.addMessage(`❌ ${(err as Error).message}`, 'assist');
                }
            }
        };

        sendBtn.onclick = () => {
            if (sendBtn.innerHTML !== originalSendIcon) {
                this.abortController?.abort();
                this.progressView?.freeze();
                setSendButtonState(false);
            } else {
                handleSend();
            }
        };

        inputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault();
                if (sendBtn.innerHTML === originalSendIcon) {
                    handleSend();
                }
            }
        });
    }

    private showInitialMessage(): void {
        this.chatPanel.addMessage('🦛 Ready. Describe your change.', 'assist');
    }
}